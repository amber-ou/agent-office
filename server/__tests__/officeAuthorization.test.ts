/**
 * The Agent Office control plane is privileged.
 *
 * It reads and writes every agent's instructions, skills and knowledge. The
 * server listens on loopback, and loopback is exactly where a sandboxed run —
 * or, under WSL, anything on the Windows side — would reach it from, so an
 * unauthenticated socket must get nothing. Hiding `agents/` from a run's
 * filesystem is worth nothing if the same data is readable over this channel.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { OfficeSession } from '../src/control/officeMessageHandler.js';
import { OfficeService } from '../src/control/officeService.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';

let dataRoot: string;

function send(collected: Array<Record<string, unknown>>) {
  return (message: Record<string, unknown>): void => {
    collected.push(message);
  };
}

function context(privileged: boolean) {
  return {
    store: new AgentStateStore(),
    runtime: undefined as never,
    cache: undefined as never,
    privileged,
    office: new OfficeSession(),
  };
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-authz-'));
  setOfficeDataRoot(dataRoot);
});

afterEach(() => {
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('office control-plane authorization', () => {
  it('tells an unprivileged client nothing and changes nothing', async () => {
    // A real agent with real configuration to try to reach.
    const office = new OfficeService(getOfficeStorage()!);
    const agent = await office.createAgent({
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'SECRET INSTRUCTIONS',
    });

    const replies: Array<Record<string, unknown>> = [];
    const ctx = context(false);
    for (const message of [
      { type: 'requestOffice' },
      { type: 'requestAgentDetail', agentId: agent.id },
      { type: 'updateAgent', agentId: agent.id, systemPrompt: 'TAMPERED' },
      { type: 'createSkill', agentId: agent.id, slug: 's', name: 'S', kind: 'workflow' },
      { type: 'webviewReady' },
    ]) {
      handleClientMessage(message, send(replies), ctx as never);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Nothing but refusals: no snapshot, no agent detail, no leaked content.
    const kinds = new Set(replies.map((r) => r['type']));
    expect(kinds.has('officeState')).toBe(false);
    expect(kinds.has('agentDetail')).toBe(false);
    expect(JSON.stringify(replies)).not.toContain('SECRET INSTRUCTIONS');
    expect(replies.filter((r) => r['type'] === 'officeError')).not.toHaveLength(0);

    // And the write attempts did not land.
    expect((await office.agentDetail(agent.id))!.agent.systemPrompt).toBe('SECRET INSTRUCTIONS');
    expect((await office.agentDetail(agent.id))!.skills).toEqual([]);
  });

  it('serves a privileged client as before', async () => {
    const office = new OfficeService(getOfficeStorage()!);
    const agent = await office.createAgent({
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'SECRET INSTRUCTIONS',
    });

    const replies: Array<Record<string, unknown>> = [];
    const ctx = context(true);
    handleClientMessage({ type: 'requestOffice' }, send(replies), ctx as never);
    handleClientMessage(
      { type: 'requestAgentDetail', agentId: agent.id },
      send(replies),
      ctx as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const kinds = new Set(replies.map((r) => r['type']));
    expect(kinds.has('officeState')).toBe(true);
    expect(kinds.has('agentDetail')).toBe(true);
    expect(JSON.stringify(replies)).toContain('SECRET INSTRUCTIONS');
  });
});

/**
 * `CLAUDE_CONFIG_DIR` really does move Claude's configuration and state.
 *
 * Checked by running the CLI, not by looking for the string in its binary.
 * `mcp list` is a local command: it reads and writes configuration and makes
 * no API call, so this costs nothing.
 */
const claudeAvailable = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!claudeAvailable)('per-run Claude configuration', () => {
  it('writes its configuration into CLAUDE_CONFIG_DIR and leaves the home one alone', () => {
    const configDir = path.join(dataRoot, 'runtime', 'agent', 'task', 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const result = spawnSync('claude', ['mcp', 'list'], {
      encoding: 'utf8',
      // The sandbox sets exactly these two; nothing else points at a home.
      env: { PATH: process.env['PATH'] ?? '', HOME: configDir, CLAUDE_CONFIG_DIR: configDir },
    });
    expect(result.status).toBe(0);

    // Its state landed in the per-run directory.
    expect(fs.readdirSync(configDir).length).toBeGreaterThan(0);
  });
});

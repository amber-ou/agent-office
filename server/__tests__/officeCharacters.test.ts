import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfficeState } from '../../core/src/messages.js';
import { ClaudeCliRuntime } from '../../runtime/src/index.js';
import { OfficeSession } from '../src/control/officeMessageHandler.js';
import { OfficeService } from '../src/control/officeService.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setClaudeDiscoveryPaths,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';
import { writeWindowsConsent } from '../src/control/runMode.js';
import { setTaskRuntime } from '../src/control/taskRunner.js';
import type { FakeClaude } from './helpers/fakeClaude.js';
import { fakeClaude } from './helpers/fakeClaude.js';

let root: string;
let claude: FakeClaude;
let savedToken: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-characters-'));
  setOfficeDataRoot(root);
  setClaudeDiscoveryPaths({
    claudeAgentsRoot: path.join(root, 'claude', 'agents'),
    claudeSkillsRoot: path.join(root, 'claude', 'skills'),
  });
  savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
  writeWindowsConsent(root, new Date().toISOString());
  claude = fakeClaude();
  setTaskRuntime(new ClaudeCliRuntime({ spawn: claude.spawn }));
});

afterEach(() => {
  setTaskRuntime(undefined);
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  setClaudeDiscoveryPaths(undefined);
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Office character snapshots', () => {
  it.each([false, true])(
    'pushes live and terminal state without opening a project workspace (failure=%s)',
    async (fail) => {
      claude.script.isError = fail;
      const service = new OfficeService(getOfficeStorage()!);
      const project = await service.createProject({ name: 'Character test' });
      const agent = await service.createAgent({
        name: 'retriever',
        role: 'retriever',
        provider: 'claude',
      });
      await service.addAgentToProject({ projectId: project.id, agentId: agent.id });
      const task = await service.createTask({
        projectId: project.id,
        title: 'Read local fixture',
        assignedAgentId: agent.id,
      });
      await service.setTaskStatus({ taskId: task.id, status: 'todo' });
      const connection = new OfficeSession();
      const snapshots: OfficeState[] = [];
      const errors: unknown[] = [];
      const send = (message: Record<string, unknown>) => {
        if (message.type === 'officeState') snapshots.push(message as unknown as OfficeState);
        if (message.type === 'officeError') errors.push(message);
      };
      await connection.handle({ type: 'setActiveProject', projectId: project.id }, send);
      await connection.handle({ type: 'runTask', taskId: task.id }, send);
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(
          snapshots.some((state) =>
            state.tasks.some((item) => item.status === (fail ? 'failed' : 'review')),
          ),
        ).toBe(true);
      });
      expect(
        snapshots.some((state) => state.tasks.some((item) => item.status === 'in_progress')),
      ).toBe(true);
      const final = snapshots.at(-1)!;
      expect(final.agents.map((item) => item.id)).toContain(agent.id);
      expect(final.sessions?.[0]).toMatchObject({
        agentId: agent.id,
        taskId: task.id,
        status: fail ? 'failed' : 'ended',
      });
      // Session identities survive reconnects even before a project is selected.
      const fresh = await new OfficeSession().initialState();
      expect((fresh as unknown as OfficeState).sessions).toEqual(final.sessions);
      expect(claude.calls.length).toBeGreaterThan(0);
    },
  );
});

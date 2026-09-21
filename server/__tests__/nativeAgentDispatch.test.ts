/**
 * Dispatch through a Claude Code NATIVE agent (`linkNativeAgent.ts`):
 * `claude --agent <name>` instead of an Office-assembled persona, on the one
 * platform this is reachable from today — a sandboxed run has no `~/.claude`
 * to read the file from (see `taskRunner.ts`'s `eligible()`), so it is
 * refused there rather than silently falling back to copying the file's text
 * into the ordinary prompt.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asAgentId } from '../../domain/src/index.js';
import { ClaudeCliRuntime } from '../../runtime/src/index.js';
import { linkNativeAgentFile } from '../../storage/src/index.js';
import { OfficeService } from '../src/control/officeService.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setClaudeDiscoveryPaths,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';
import { writeWindowsConsent } from '../src/control/runMode.js';
import { getTaskRunner, setTaskRuntime } from '../src/control/taskRunner.js';
import type { FakeClaude } from './helpers/fakeClaude.js';
import { fakeClaude } from './helpers/fakeClaude.js';

let dataRoot: string;
let nativeRoot: string;
let claude: FakeClaude;

function service(): OfficeService {
  const storage = getOfficeStorage();
  if (!storage) throw new Error('storage failed to open');
  return new OfficeService(storage);
}

function runner(): ReturnType<typeof getTaskRunner> {
  const storage = getOfficeStorage();
  if (!storage) throw new Error('storage failed to open');
  return getTaskRunner(storage);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 200 && runner().liveRun(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * These tests mock `process.platform` to `'win32'` (the platform this whole
 * feature targets), which routes `ClaudeCliRuntime` through
 * `windowsSafeLaunch`: the real argv becomes one quoted `cmd.exe /d /s /c
 * "..."` string rather than separate elements. This unwraps that quoting
 * back into the individual arguments `claude` was given.
 */
function claudeArgv(calls: string[][]): string[] {
  const cmdCall = calls.find((argv) => argv[0] === 'cmd.exe');
  if (cmdCall) {
    const line = cmdCall[cmdCall.length - 1]!.replace(/^"(.*)"$/, '$1');
    const tokens = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      m[1]!.replace(/\\"/g, '"'),
    );
    if (tokens.includes('claude') && tokens.includes('-p')) {
      return tokens.slice(tokens.indexOf('claude'));
    }
  }
  const call = calls.find((argv) => argv.includes('claude') && argv.includes('-p'));
  if (!call) throw new Error('no claude invocation was recorded');
  return call.slice(call.indexOf('claude'));
}

const REVIEWER = [
  '---',
  'name: code-reviewer',
  'description: Reviews code for correctness and clarity',
  'tools: Read, Grep, Bash',
  'model: sonnet',
  '---',
  '',
  'You are a careful, concise code reviewer. This persona must come from CC, not from Office.',
  '',
].join('\n');

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-native-dispatch-'));
  nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-native-dispatch-'));
  setOfficeDataRoot(dataRoot);
  // The same root linkNativeAgentFile is given below, so eligible()'s own
  // discoverability re-check (taskRunner.ts) agrees with what was linked.
  setClaudeDiscoveryPaths({
    claudeAgentsRoot: nativeRoot,
    claudeSkillsRoot: path.join(nativeRoot, '..', 'skills'),
  });
  claude = fakeClaude();
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token';
  writeWindowsConsent(dataRoot, new Date().toISOString());
  setTaskRuntime(new ClaudeCliRuntime({ spawn: claude.spawn }));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  setTaskRuntime(undefined);
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  setClaudeDiscoveryPaths(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(nativeRoot, { recursive: true, force: true });
});

async function nativeAgentProjectWithTask(): Promise<{
  office: OfficeService;
  projectId: string;
  agentId: string;
  taskId: string;
}> {
  const storage = getOfficeStorage()!;
  const file = path.join(nativeRoot, 'reviewer.md');
  fs.writeFileSync(file, REVIEWER);
  const linked = await linkNativeAgentFile(
    storage.repos,
    storage.agentFiles,
    file,
    {
      ids: (await import('../../domain/src/index.js')).uuidIdGenerator,
      clock: (await import('../../domain/src/index.js')).systemClock,
    },
    nativeRoot,
  );
  if (!linked.ok) throw new Error(linked.reason);

  const office = service();
  const project = await office.createProject({ name: 'Repo review' });
  await office.addAgentToProject({ projectId: project.id, agentId: linked.agent.id });
  const task = await office.createTask({
    projectId: project.id,
    title: 'Review the diff',
    description: 'Look for real bugs.',
    assignedAgentId: linked.agent.id,
  });
  await office.setTaskStatus({ taskId: task.id, status: 'todo' });
  return { office, projectId: project.id, agentId: linked.agent.id, taskId: task.id };
}

describe('dispatch through a native Claude Code agent', () => {
  it('runs claude --agent <name>, not --model, and sends no Office-assembled persona', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { projectId, taskId } = await nativeAgentProjectWithTask();

    await runner().run(taskId, projectId);
    await settle();

    const argv = claudeArgv(claude.calls);
    expect(argv).toContain('--agent');
    expect(argv[argv.indexOf('--agent') + 1]).toBe('code-reviewer');
    expect(argv).not.toContain('--model');

    const prompt = claude.prompts[0]!;
    expect(prompt).toContain('Review the diff');
    expect(prompt).toContain('Look for real bugs.');
    // The persona lives in CC's own file now — Office must not also inline it.
    expect(prompt).not.toContain('This persona must come from CC, not from Office.');
  });

  it('re-reads the file at dispatch time, so an edit in Claude Code needs no re-link', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { projectId, taskId, agentId } = await nativeAgentProjectWithTask();
    const storage = getOfficeStorage()!;
    const meta = await storage.agentFiles.readOfficeMeta(asAgentId(agentId));
    fs.writeFileSync(
      meta!.nativeAgentPath!,
      REVIEWER.replace('name: code-reviewer', 'name: code-reviewer-v2'),
    );

    await runner().run(taskId, projectId);
    await settle();

    const argv = claudeArgv(claude.calls);
    expect(argv[argv.indexOf('--agent') + 1]).toBe('code-reviewer-v2');
  });

  it('refuses a sandboxed (non-Windows) dispatch rather than silently falling back', async () => {
    // Default test platform (not mocked to win32): decideRunMode chooses
    // 'sandboxed', which has no ~/.claude to read the native file from.
    const { projectId, taskId } = await nativeAgentProjectWithTask();

    await expect(runner().run(taskId, projectId)).rejects.toThrow(/sandboxed run cannot reach/);
    expect(claude.prompts).toEqual([]);
  });

  it('refuses to dispatch once a sibling file starts sharing the linked name, rather than guessing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { projectId, taskId } = await nativeAgentProjectWithTask();
    // A second file created AFTER linking, sharing the same `name:` — the
    // situation the one-time link could not have caught.
    fs.writeFileSync(path.join(nativeRoot, 'reviewer-2.md'), REVIEWER);

    await expect(runner().run(taskId, projectId)).rejects.toThrow(/other file/);
    expect(claude.prompts).toEqual([]);
  });
});

/**
 * Human review and continuation.
 *
 * Run → review → accept, or run → review → feedback → revision → review, as
 * many times as the work needs. The `claude` process is faked; the bridge, the
 * session records, the outputs and the database are real.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCliRuntime } from '../../runtime/src/index.js';
import { OfficeService } from '../src/control/officeService.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';
import { getTaskRunner, setTaskRuntime } from '../src/control/taskRunner.js';
import type { FakeClaude } from './helpers/fakeClaude.js';
import { fakeClaude } from './helpers/fakeClaude.js';

let dataRoot: string;
let claude: FakeClaude;

function service(): OfficeService {
  const storage = getOfficeStorage();
  if (!storage) {
    throw new Error('storage failed to open');
  }
  return new OfficeService(storage);
}

function runner(): ReturnType<typeof getTaskRunner> {
  return getTaskRunner(getOfficeStorage()!);
}

function reopen(): OfficeService {
  closeOfficeStorage();
  setOfficeDataRoot(dataRoot);
  return service();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 200 && runner().liveRun(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A project with one member and one task, run once and now awaiting review. */
async function reviewedTask(office: OfficeService): Promise<{
  projectId: string;
  agentId: string;
  taskId: string;
}> {
  const project = await office.createProject({ name: 'AiWow' });
  const agent = await office.createAgent({ name: 'UX Agent', role: 'ux', provider: 'claude' });
  await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
  const task = await office.createTask({
    projectId: project.id,
    title: 'Draft the welcome copy',
    assignedAgentId: agent.id,
  });
  await office.setTaskStatus({ taskId: task.id, status: 'todo' });
  claude.script = { result: 'v1: welcome aboard' };
  await runner().run(task.id, project.id);
  await settle();
  return { projectId: project.id, agentId: agent.id, taskId: task.id };
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-review-'));
  setOfficeDataRoot(dataRoot);
  claude = fakeClaude();
  // A sandboxed run authenticates from the environment; without this the
  // runner refuses to dispatch at all, which is its own test below.
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token';
  setTaskRuntime(new ClaudeCliRuntime({ spawn: claude.spawn }));
});

afterEach(() => {
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  setTaskRuntime(undefined);
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('human review', () => {
  it('accepts a reviewed result without invoking Claude', async () => {
    const office = service();
    const { projectId, taskId } = await reviewedTask(office);
    const callsBefore = claude.calls.filter((argv) => argv.includes('-p')).length;

    await office.acceptTask(taskId);

    const detail = (await reopen().projectDetail(projectId))!;
    expect(detail.tasks[0]!.status).toBe('done');
    // No second process, and the result is still there.
    expect(claude.calls.filter((argv) => argv.includes('-p'))).toHaveLength(callsBefore);
    expect(detail.outputs).toHaveLength(1);
    expect(detail.sessions).toHaveLength(1);
  });

  it('refuses accept and request-changes outside review', async () => {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
    const task = await office.createTask({
      projectId: project.id,
      title: 'Not run yet',
      assignedAgentId: agent.id,
    });
    await office.setTaskStatus({ taskId: task.id, status: 'todo' });

    await expect(office.acceptTask(task.id)).rejects.toThrow(/only a task in review/);
    await expect(runner().revise(task.id, 'change it', project.id)).rejects.toThrow(
      /only a task in review/,
    );
    expect(claude.calls.filter((argv) => argv.includes('-p'))).toEqual([]);

    // And an accepted task cannot be accepted twice.
    const { taskId } = await reviewedTask(office);
    await office.acceptTask(taskId);
    await expect(office.acceptTask(taskId)).rejects.toThrow(/only a task in review/);
  });

  it('requires non-empty feedback', async () => {
    const office = service();
    const { projectId, taskId } = await reviewedTask(office);
    const callsBefore = claude.calls.filter((argv) => argv.includes('-p')).length;

    await expect(runner().revise(taskId, '   ', projectId)).rejects.toThrow(/must not be empty/);
    expect(claude.calls.filter((argv) => argv.includes('-p'))).toHaveLength(callsBefore);
    // Nothing moved.
    expect((await office.projectDetail(projectId))!.tasks[0]!.status).toBe('review');
  });

  it('continues the same Claude session and sends only the feedback', async () => {
    const office = service();
    const { projectId, taskId } = await reviewedTask(office);
    const first = (await office.projectDetail(projectId))!.sessions[0]!;

    claude.script = { result: 'v2: welcome, with a mobile state' };
    await runner().revise(taskId, 'Mobile flow needs another state', projectId);
    await settle();

    // The second invocation resumes the first run's provider session. Each run
    // is preceded by its sandbox probe, so the claude calls are picked out.
    const claudeCalls = claude.calls.filter((argv) => argv.includes('-p'));
    const revisionCall = claudeCalls[1]!;
    expect(revisionCall).toContain('--resume');
    expect(revisionCall[revisionCall.indexOf('--resume') + 1]).toBe(first.providerSessionId);
    expect(revisionCall).not.toContain('--session-id');

    // The feedback is in the prompt, and the bulk of the first prompt is not
    // re-sent — Claude still holds it.
    const revisionPrompt = claude.prompts[1]!;
    expect(revisionPrompt).toContain('Mobile flow needs another state');
    expect(revisionPrompt.length).toBeLessThan(claude.prompts[0]!.length);
    expect(revisionPrompt).not.toContain('v1: welcome aboard');
  });

  it('creates a new output per revision and keeps the old ones', async () => {
    const office = service();
    const { projectId, taskId } = await reviewedTask(office);

    claude.script = { result: 'v2: with a mobile state' };
    await runner().revise(taskId, 'Mobile flow needs another state', projectId);
    await settle();
    claude.script = { result: 'v3: edge case handled' };
    await runner().revise(taskId, 'Fix the edge case', projectId);
    await settle();

    const after = reopen();
    const detail = (await after.projectDetail(projectId))!;

    // Three runs, three outputs, two pieces of feedback — nothing overwritten.
    expect(detail.sessions).toHaveLength(3);
    expect(detail.sessions.every((s) => s.status === 'ended')).toBe(true);
    expect(detail.outputs).toHaveLength(3);
    expect(detail.reviewNotes.map((n) => n.body)).toEqual([
      'Mobile flow needs another state',
      'Fix the edge case',
    ]);

    const texts = await Promise.all(
      detail.outputs.map(async (o) => (await after.outputContent(o.id))?.content),
    );
    expect(texts.sort()).toEqual([
      'v1: welcome aboard',
      'v2: with a mobile state',
      'v3: edge case handled',
    ]);

    // Every output is attached to the task, and it is back in review.
    const task = detail.tasks[0]!;
    expect(task.outputs).toHaveLength(3);
    expect(task.status).toBe('review');

    // Each note names the run it was written about and the one it started.
    const oldest = detail.reviewNotes[0]!;
    expect(oldest.aboutSessionId).toBeDefined();
    expect(oldest.triggeredSessionId).toBeDefined();
    expect(oldest.aboutSessionId).not.toBe(oldest.triggeredSessionId);

    // Every run continued the one conversation.
    const providerIds = new Set(detail.sessions.map((s) => s.providerSessionId));
    expect(providerIds.size).toBe(1);

    // And it can still be accepted at the end.
    await after.acceptTask(taskId);
    expect((await reopen().projectDetail(projectId))!.tasks[0]!.status).toBe('done');
  });

  it('keeps earlier results when a revision fails', async () => {
    const office = service();
    const { projectId, taskId } = await reviewedTask(office);

    claude.script = { result: '', exitCode: 1 };
    await runner().revise(taskId, 'Fix the edge case', projectId);
    await settle();

    const detail = (await reopen().projectDetail(projectId))!;
    // The failed revision is recorded, the first result is untouched.
    expect(detail.sessions.map((s) => s.status)).toEqual(['failed', 'ended']);
    expect(detail.sessions[0]!.error).toBeTruthy();
    expect(detail.outputs).toHaveLength(1);
    expect(detail.reviewNotes.map((n) => n.body)).toEqual(['Fix the edge case']);

    const task = detail.tasks[0]!;
    expect(task.outputs).toHaveLength(1);
    // Retryable: failed → todo → run again, and the earlier work survives.
    expect(task.status).toBe('failed');
    const after = reopen();
    await after.setTaskStatus({ taskId, status: 'todo' });
    claude.script = { result: 'v2: fixed' };
    await runner().run(taskId, projectId);
    await settle();
    const recovered = (await reopen().projectDetail(projectId))!;
    expect(recovered.outputs).toHaveLength(2);
    expect(recovered.reviewNotes).toHaveLength(1);
  });

  it('teaches the agent nothing, however much feedback it is given', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await reviewedTask(office);
    const before = await office.agentDetail(agentId);

    claude.script = { result: 'v2' };
    await runner().revise(taskId, 'Remember that we always write in British English', projectId);
    await settle();
    claude.script = { result: 'v3' };
    await runner().revise(taskId, 'And never use exclamation marks', projectId);
    await settle();

    const after = (await reopen().agentDetail(agentId))!;
    expect(after.agent).toEqual(before!.agent);
    expect(after.skills).toEqual(before!.skills);
    expect(after.knowledge).toEqual([]);
  });

  it('does not inherit the previous agent-s session when the task is reassigned', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await reviewedTask(office);
    const first = (await office.projectDetail(projectId))!.sessions[0]!;

    // Hand the task to someone else, then ask for changes.
    const other = await office.createAgent({ name: 'QA', role: 'qa', provider: 'claude' });
    await office.addAgentToProject({ projectId, agentId: other.id });
    await office.assignTask({ taskId, agentId: other.id });

    claude.script = { result: 'fresh start' };
    await runner().revise(taskId, 'Try it differently', projectId);
    await settle();

    // A new conversation: no --resume, and a session id of its own.
    const claudeCalls = claude.calls.filter((argv) => argv.includes('-p'));
    expect(claudeCalls[1]).not.toContain('--resume');
    expect(claudeCalls[1]).toContain('--session-id');

    const sessions = (await reopen().projectDetail(projectId))!.sessions;
    expect(sessions[0]!.agentId).toBe(other.id);
    expect(sessions[0]!.providerSessionId).not.toBe(first.providerSessionId);
    // The earlier agent's run and output are untouched.
    expect(sessions[1]!.agentId).toBe(agentId);
    expect((await reopen().projectDetail(projectId))!.outputs).toHaveLength(2);
  });

  it('still runs one task at a time', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await reviewedTask(office);
    const second = await office.createTask({
      projectId,
      title: 'Another',
      assignedAgentId: agentId,
    });
    await office.setTaskStatus({ taskId: second.id, status: 'todo' });

    claude.script = { result: 'v2' };
    await runner().revise(taskId, 'Change it', projectId);
    await expect(runner().run(second.id, projectId)).rejects.toThrow(/already running/);
    await expect(runner().revise(taskId, 'Again', projectId)).rejects.toThrow(/already running/);
    await settle();
  });
});

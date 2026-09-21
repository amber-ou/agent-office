/**
 * One REAL Claude Code execution through the actual bridge.
 *
 * Nothing is mocked: the real `ClaudeCliRuntime` spawns the real `claude`
 * binary, and the result is persisted through the real SQLite database. It is
 * opt-in because it costs tokens and needs a logged-in CLI:
 *
 *   AGENT_OFFICE_CLAUDE_SMOKE=1 npx vitest run --root server __tests__/claudeSmoke.test.ts
 *
 * The task is deliberately trivial — one word back, then one word after a
 * revision — so the proof costs as little as possible.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OfficeService } from '../src/control/officeService.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';
import { getTaskRunner } from '../src/control/taskRunner.js';

// A run is sandboxed and authenticates from the environment, so both have to be
// present. Missing either is a skip, never a silent unsandboxed run.
const sandboxReady = spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0;
const credentialReady = Boolean(process.env['CLAUDE_CODE_OAUTH_TOKEN']);
const enabled = process.env.AGENT_OFFICE_CLAUDE_SMOKE === '1' && sandboxReady && credentialReady;
let dataRoot: string;

function service(): OfficeService {
  const storage = getOfficeStorage();
  if (!storage) {
    throw new Error('storage failed to open');
  }
  return new OfficeService(storage);
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-smoke-'));
  setOfficeDataRoot(dataRoot);
});

function reopen(): OfficeService {
  closeOfficeStorage();
  setOfficeDataRoot(dataRoot);
  return service();
}

afterEach(() => {
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('real Claude Code execution', () => {
  it(
    'runs a task, revises it on feedback, and keeps both results',
    { timeout: 300_000 },
    async () => {
      const office = service();
      const project = await office.createProject({ name: 'Smoke' });
      const agent = await office.createAgent({
        name: 'Smoke Agent',
        role: 'smoke',
        provider: 'claude',
        // The cheapest model available, for a one-word answer.
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: 'Answer in as few words as possible.',
      });
      await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
      const task = await office.createTask({
        projectId: project.id,
        title: 'Say ONE',
        description: 'Reply with exactly: ONE',
        assignedAgentId: agent.id,
      });
      await office.setTaskStatus({ taskId: task.id, status: 'todo' });

      const runner = getTaskRunner(getOfficeStorage()!);
      await runner.run(task.id, project.id);
      await settle(runner);

      const first = (await office.projectDetail(project.id))!;
      // A failure here is a real failure, reported with whatever the runtime said.
      expect(first.sessions[0]!.error ?? '').toBe('');
      expect(first.sessions[0]!.status).toBe('ended');
      expect(first.tasks[0]!.status).toBe('review');
      expect(first.outputs).toHaveLength(1);
      const v1 = await office.outputContent(first.outputs[0]!.id);
      console.log(`[smoke] run 1: ${JSON.stringify(v1?.content)}`);
      expect(v1?.content).toContain('ONE');

      // Request changes: the same Claude session continues.
      await runner.revise(task.id, 'Now reply with exactly: TWO', project.id);
      await settle(runner);

      const after = reopen();
      const second = (await after.projectDetail(project.id))!;
      expect(second.sessions[0]!.error ?? '').toBe('');
      expect(second.sessions).toHaveLength(2);
      // One conversation, two runs.
      expect(new Set(second.sessions.map((s) => s.providerSessionId)).size).toBe(1);

      expect(second.outputs).toHaveLength(2);
      const revision = second.outputs.find((o) => o.sessionId === second.sessions[0]!.id)!;
      const v2 = await after.outputContent(revision.id);
      console.log(`[smoke] revision: ${JSON.stringify(v2?.content)}`);
      expect(v2?.content).toContain('TWO');

      // The first result is still there, and so is the feedback.
      const original = second.outputs.find((o) => o.id !== revision.id)!;
      expect((await after.outputContent(original.id))?.content).toContain('ONE');
      expect(second.reviewNotes.map((n) => n.body)).toEqual(['Now reply with exactly: TWO']);

      // Accept it.
      expect(second.tasks[0]!.status).toBe('review');
      await after.acceptTask(task.id);
      expect((await reopen().projectDetail(project.id))!.tasks[0]!.status).toBe('done');

      // None of it became agent knowledge.
      expect((await reopen().agentDetail(agent.id))!.knowledge).toEqual([]);
    },
  );
});

/** Wait for the live run to finish and its outcome to be recorded. */
async function settle(runner: ReturnType<typeof getTaskRunner>): Promise<void> {
  for (let i = 0; i < 600 && runner.liveRun(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(runner.liveRun()).toBeUndefined();
}

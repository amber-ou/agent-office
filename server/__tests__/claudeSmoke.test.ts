/**
 * One REAL Claude Code execution through the actual bridge.
 *
 * Nothing is mocked: the real `ClaudeCliRuntime` spawns the real `claude`
 * binary, and the result is persisted through the real SQLite database. It is
 * opt-in because it costs tokens and needs a logged-in CLI:
 *
 *   AGENT_OFFICE_CLAUDE_SMOKE=1 npx vitest run --root server __tests__/claudeSmoke.test.ts
 *
 * The task is deliberately trivial — one word back — so the proof costs as
 * little as possible.
 */

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

const enabled = process.env.AGENT_OFFICE_CLAUDE_SMOKE === '1';
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

afterEach(() => {
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('real Claude Code execution', () => {
  it('runs one trivial task end to end', { timeout: 300_000 }, async () => {
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
      title: 'Say OK',
      description: 'Reply with exactly: OK',
      assignedAgentId: agent.id,
    });
    await office.setTaskStatus({ taskId: task.id, status: 'todo' });

    const storage = getOfficeStorage()!;
    const runner = getTaskRunner(storage);
    await runner.run(task.id, project.id);

    // The run is in flight; wait for the bridge to record its outcome.
    for (let i = 0; i < 600 && runner.liveRun(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(runner.liveRun()).toBeUndefined();

    const detail = (await office.projectDetail(project.id))!;
    const session = detail.sessions[0]!;
    // A failure here is a real failure, reported with whatever the runtime said.
    expect(session.error ?? '').toBe('');
    expect(session.status).toBe('ended');
    expect(session.taskId).toBe(task.id);

    expect(detail.outputs).toHaveLength(1);
    const output = await office.outputContent(detail.outputs[0]!.id);
    expect(output?.content?.trim()).toBeTruthy();
    console.log(`[smoke] Claude replied: ${JSON.stringify(output?.content?.slice(0, 200))}`);

    expect(detail.tasks[0]!.status).toBe('review');
    // The run taught the agent nothing.
    expect((await office.agentDetail(agent.id))!.knowledge).toEqual([]);
  });
});

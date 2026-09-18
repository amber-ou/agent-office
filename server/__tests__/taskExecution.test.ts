/**
 * The Claude Code bridge, with a fake `claude` process.
 *
 * The runtime adapter under test is the REAL `ClaudeCliRuntime`: only the
 * `spawn` it calls is replaced, so the argument list, the prompt on stdin and
 * the JSON parsing are all exercised. The production path never injects
 * anything — `setTaskRuntime` is a test seam and nothing else uses it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCliRuntime } from '../../runtime/src/index.js';
import { assembleContext } from '../src/control/contextAssembly.js';
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
  const storage = getOfficeStorage();
  if (!storage) {
    throw new Error('storage failed to open');
  }
  return getTaskRunner(storage);
}

function reopen(): OfficeService {
  closeOfficeStorage();
  setOfficeDataRoot(dataRoot);
  return service();
}

/**
 * The `claude` part of a sandboxed invocation.
 *
 * Every run goes through bubblewrap now, so a call is
 * `[bwrap, …namespace…, --, claude, …]` and the probe that precedes it is its
 * own call. This picks out the arguments Claude itself was given.
 */
function claudeArgv(calls: string[][]): string[] {
  const call = calls.find((argv) => argv.includes('claude') && argv.includes('-p'));
  if (!call) {
    throw new Error('no claude invocation was recorded');
  }
  return call.slice(call.indexOf('claude'));
}

/** Every file under a directory, with its contents. */
function snapshotTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return files;
}

/** Wait for the live run to finish and its outcome to be recorded. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && runner().liveRun(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function projectWithTask(office: OfficeService): Promise<{
  projectId: string;
  agentId: string;
  taskId: string;
}> {
  const project = await office.createProject({ name: 'AiWow' });
  const agent = await office.createAgent({
    name: 'UX Agent',
    role: 'ux',
    provider: 'claude',
    systemPrompt: 'Cite the transcript.',
  });
  await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
  const task = await office.createTask({
    projectId: project.id,
    title: 'Draft the welcome copy',
    description: 'Three screens, one voice.',
    assignedAgentId: agent.id,
  });
  await office.setTaskStatus({ taskId: task.id, status: 'todo' });
  return { projectId: project.id, agentId: agent.id, taskId: task.id };
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-exec-'));
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

describe('task execution', () => {
  it('refuses to dispatch a task that is not ready', async () => {
    const office = service();
    const project = await office.createProject({ name: 'AiWow' });
    const agent = await office.createAgent({ name: 'UX', role: 'ux', provider: 'claude' });

    // No agent assigned.
    const unassigned = await office.createTask({ projectId: project.id, title: 'Unassigned' });
    await office.setTaskStatus({ taskId: unassigned.id, status: 'todo' });
    await expect(runner().run(unassigned.id, project.id)).rejects.toThrow(/no assigned agent/);

    // Assigned, but the agent is not a member — the service refuses the
    // assignment itself, so the only way in is a task that predates the removal.
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
    const task = await office.createTask({
      projectId: project.id,
      title: 'Assigned',
      assignedAgentId: agent.id,
    });
    await office.setTaskStatus({ taskId: task.id, status: 'todo' });
    await office.removeAgentFromProject({ projectId: project.id, agentId: agent.id });
    // Removal unassigned it, so re-assign by hand to reach the membership gate.
    await office.addAgentToProject({ projectId: project.id, agentId: agent.id });
    await office.assignTask({ taskId: task.id, agentId: agent.id });
    await office.removeAgentFromProject({ projectId: project.id, agentId: agent.id });
    await expect(runner().run(task.id, project.id)).rejects.toThrow(/no assigned agent/);

    // Nothing ran.
    expect(claude.prompts).toEqual([]);
  });

  it('refuses a task from another project and a task that cannot start', async () => {
    const office = service();
    const { taskId, projectId } = await projectWithTask(office);
    const other = await office.createProject({ name: 'Beta' });

    await expect(runner().run(taskId, other.id)).rejects.toThrow(/active project/);

    // backlog cannot go straight to in_progress, assigned or not.
    const assignee = (await office.projectDetail(projectId))!.memberships[0]!.agentId;
    const backlog = await office.createTask({
      projectId,
      title: 'Later',
      assignedAgentId: assignee,
    });
    await expect(runner().run(backlog.id, projectId)).rejects.toThrow(/cannot start/);
    expect(claude.prompts).toEqual([]);
  });

  it('refuses a task whose dependencies are not done', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    const research = await office.createTask({ projectId, title: 'Research' });
    await office.updateTask({ taskId, dependencies: [research.id] });
    await office.assignTask({ taskId, agentId });

    await expect(runner().run(taskId, projectId)).rejects.toThrow(/unmet dependenc/);
    expect(claude.prompts).toEqual([]);
    // The task was not moved by the refusal.
    expect(
      (await office.projectDetail(projectId))!.tasks.find((t) => t.id === taskId)!.status,
    ).toBe('todo');
  });

  it('assembles context from the agent, the project and the task — and nothing else', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    await office.updateProject({ projectId, description: 'Onboarding redesign' });
    await office.createSkill({
      agentId,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });
    await office.createAgentKnowledge({
      agentId,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'AGENT-KNOWLEDGE-BODY',
    });
    const brand = await office.createProjectKnowledge({
      projectId,
      title: 'Brand voice',
      knowledgeType: 'design_system',
      content: 'PROJECT-KNOWLEDGE-BODY',
    });
    await office.updateTask({
      taskId,
      inputs: [{ kind: 'projectKnowledge', knowledgeId: brand.id }],
    });

    // Another project's knowledge must never be a candidate.
    const other = await office.createProject({ name: 'Beta' });
    await office.createProjectKnowledge({
      projectId: other.id,
      title: 'Elsewhere',
      knowledgeType: 'markdown',
      content: 'OTHER-PROJECT-BODY',
    });

    await runner().run(taskId, projectId);
    await settle();

    const prompt = claude.prompts[0]!;
    // Agent-owned.
    expect(prompt).toContain('UX Agent');
    expect(prompt).toContain('Cite the transcript.');
    expect(prompt).toContain('Ask open questions.');
    expect(prompt).toContain('AGENT-KNOWLEDGE-BODY');
    // Project- and task-owned.
    expect(prompt).toContain('Onboarding redesign');
    expect(prompt).toContain('PROJECT-KNOWLEDGE-BODY');
    expect(prompt).toContain('Draft the welcome copy');
    expect(prompt).toContain('Three screens, one voice.');
    // Nothing from anywhere else.
    expect(prompt).not.toContain('OTHER-PROJECT-BODY');
  });

  it('honours the context budget without touching what it selected from', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    for (let i = 0; i < 10; i++) {
      await office.createAgentKnowledge({
        agentId,
        title: `Note ${i}`,
        knowledgeType: 'markdown',
        content: `BODY-${i}`,
      });
    }
    const storage = getOfficeStorage()!;
    const task = (await office.projectDetail(projectId))!.tasks.find((t) => t.id === taskId)!;
    const { bundle } = await assembleContext(storage, task);

    // The default budget caps agent knowledge at 8 items; the other two stay in
    // the agent's library untouched.
    expect(bundle.agentKnowledge).toHaveLength(8);
    expect((await office.agentDetail(agentId))!.knowledge).toHaveLength(10);
  });

  it('runs a task and persists the output, the session and the state', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    claude.script = { result: 'Welcome aboard. Here is the copy.' };

    const started = await runner().run(taskId, projectId);
    await settle();

    // The Office session id is what Claude was told to use.
    expect(claudeArgv(claude.calls).slice(0, 6)).toEqual([
      'claude',
      '-p',
      '--output-format',
      'json',
      '--session-id',
      started.sessionId,
    ]);

    const after = reopen();
    const detail = (await after.projectDetail(projectId))!;

    // Session: associated with agent, project and task.
    expect(detail.sessions).toHaveLength(1);
    const session = detail.sessions[0]!;
    expect(session.status).toBe('ended');
    expect(session.agentId).toBe(agentId);
    expect(session.projectId).toBe(projectId);
    expect(session.taskId).toBe(taskId);
    expect(session.providerSessionId).toBe(started.sessionId);
    expect(session.endedAt).toBeDefined();

    // Output: persisted, attached to the task, readable after a reopen.
    expect(detail.outputs).toHaveLength(1);
    const output = detail.outputs[0]!;
    expect(output.taskId).toBe(taskId);
    expect(output.sessionId).toBe(session.id);
    expect(output.producedByAgentId).toBe(agentId);
    const resolved = await after.outputContent(output.id);
    expect(resolved?.content).toBe('Welcome aboard. Here is the copy.');

    const task = detail.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe('review');
    expect(task.outputs).toEqual([output.id]);
  });

  it('does not turn a run into agent memory', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    const before = await office.agentDetail(agentId);
    claude.script = { result: 'I learned a great deal about this project.' };

    await runner().run(taskId, projectId);
    await settle();

    const after = (await reopen().agentDetail(agentId))!;
    expect(after.agent).toEqual(before!.agent);
    expect(after.skills).toEqual(before!.skills);
    expect(after.knowledge).toEqual([]);
  });

  it('records a failed run and leaves the task retryable', async () => {
    const office = service();
    const { projectId, taskId } = await projectWithTask(office);
    claude.script = { result: '', exitCode: 1 };

    await runner().run(taskId, projectId);
    await settle();

    const after = reopen();
    const detail = (await after.projectDetail(projectId))!;
    expect(detail.sessions[0]!.status).toBe('failed');
    expect(detail.sessions[0]!.error).toBeTruthy();
    // No output was invented for a run that produced none.
    expect(detail.outputs).toEqual([]);

    const task = detail.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe('failed');
    // Retryable: the domain allows failed → todo, and the task runs again.
    await after.setTaskStatus({ taskId, status: 'todo' });
    claude.script = { result: 'second time lucky' };
    await runner().run(taskId, projectId);
    await settle();
    expect((await reopen().projectDetail(projectId))!.outputs).toHaveLength(1);
  });

  it('keeps the error text when Claude itself reports a failure', async () => {
    const office = service();
    const { projectId, taskId } = await projectWithTask(office);
    claude.script = { result: 'rate limited', isError: true };

    await runner().run(taskId, projectId);
    await settle();

    const detail = (await reopen().projectDetail(projectId))!;
    expect(detail.sessions[0]!.status).toBe('failed');
    expect(detail.sessions[0]!.error).toContain('rate limited');
  });

  it('reads the agent-s context from its files, and leaves them alone', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    await office.createSkill({
      agentId,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'SKILL-FROM-FILE',
    });
    await office.createAgentKnowledge({
      agentId,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'KNOWLEDGE-FROM-FILE',
    });

    // Edit the files directly: what the run sees must be what is on disk.
    const agentDir = path.join(dataRoot, 'agents', agentId);
    fs.writeFileSync(
      path.join(agentDir, 'discovery', 'agent.md'),
      'INSTRUCTIONS-FROM-FILE',
      'utf8',
    );
    const before = snapshotTree(agentDir);

    claude.script = { result: 'done' };
    await runner().run(taskId, projectId);
    await settle();

    const prompt = claude.prompts[0]!;
    expect(prompt).toContain('INSTRUCTIONS-FROM-FILE');
    expect(prompt).toContain('SKILL-FROM-FILE');
    expect(prompt).toContain('KNOWLEDGE-FROM-FILE');

    // The run wrote nothing into the agent's own files.
    expect(snapshotTree(agentDir)).toEqual(before);
  });

  it('tells the runtime the agent files are off limits', async () => {
    const office = service();
    const { projectId, taskId } = await projectWithTask(office);
    await runner().run(taskId, projectId);
    await settle();

    const call = claudeArgv(claude.calls);
    const settings = call[call.indexOf('--settings') + 1]!;
    const agentsRoot = path.join(dataRoot, 'agents');
    // Claude's own permission syntax: an absolute path takes a leading `//`.
    expect(JSON.parse(settings)).toEqual({
      permissions: {
        deny: [
          `Read(//${agentsRoot.replace(/^\/+/, '')}/**)`,
          `Write(//${agentsRoot.replace(/^\/+/, '')}/**)`,
          `Edit(//${agentsRoot.replace(/^\/+/, '')}/**)`,
          `NotebookEdit(//${agentsRoot.replace(/^\/+/, '')}/**)`,
        ],
      },
    });
  });

  it('refuses to dispatch when the sandbox is unavailable', async () => {
    const office = service();
    const { projectId, taskId } = await projectWithTask(office);
    claude.sandboxAvailable = false;

    // Fail closed: there is no unsandboxed fallback.
    await expect(runner().run(taskId, projectId)).rejects.toThrow(/sandbox is unavailable/);
    expect(claude.prompts).toEqual([]);
    // The task did not move.
    expect(
      (await office.projectDetail(projectId))!.tasks.find((t) => t.id === taskId)!.status,
    ).toBe('todo');
  });

  it('refuses to dispatch without a credential in the environment', async () => {
    const office = service();
    const { projectId, taskId } = await projectWithTask(office);
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];

    await expect(runner().run(taskId, projectId)).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(claude.prompts).toEqual([]);
  });

  it('gives each agent and each task its own config and working directory', async () => {
    const office = service();
    const first = await projectWithTask(office);
    const second = await office.createTask({
      projectId: first.projectId,
      title: 'Another task',
      assignedAgentId: first.agentId,
    });
    await office.setTaskStatus({ taskId: second.id, status: 'todo' });

    await runner().run(first.taskId, first.projectId);
    await settle();
    await runner().run(second.id, first.projectId);
    await settle();

    const runtimeRoot = path.join(dataRoot, 'runtime', first.agentId);
    expect(fs.readdirSync(runtimeRoot).sort()).toEqual([first.taskId, second.id].sort());
    for (const taskId of [first.taskId, second.id]) {
      expect(fs.readdirSync(path.join(runtimeRoot, taskId)).sort()).toEqual(['config', 'work']);
    }

    // The same task keeps its directory, so a revision resumes in place.
    const call = claudeArgv(claude.calls);
    expect(call).toContain('--session-id');
    const sandboxCall = claude.calls.find(
      (argv) => argv.includes('--unshare-all') && argv.includes('claude'),
    )!;
    expect(sandboxCall.join(' ')).toContain(
      `--setenv CLAUDE_CONFIG_DIR ${path.join(runtimeRoot, first.taskId, 'config')}`,
    );
  });

  it('runs one task at a time', async () => {
    const office = service();
    const { projectId, agentId, taskId } = await projectWithTask(office);
    const second = await office.createTask({
      projectId,
      title: 'Another',
      assignedAgentId: agentId,
    });
    await office.setTaskStatus({ taskId: second.id, status: 'todo' });

    await runner().run(taskId, projectId);
    await expect(runner().run(second.id, projectId)).rejects.toThrow(/already running/);
    await settle();
  });
});

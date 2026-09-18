/**
 * Runtime smoke test: the vertical slice through the REAL application path.
 *
 * A real `PixelAgentsServer` on a real port, a real WebSocket client, the real
 * `handleClientMessage` dispatch, the real `OfficeSession`, a real
 * `node-sqlite3-wasm` database on disk. No repository is called directly and no
 * service is constructed by the test — everything goes over the wire.
 *
 * This is what proves the driver actually loads in the server runtime, not just
 * under a unit test that imports the adapter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Isolated temp HOME: the server writes ~/.pixel-agents/{server.json,servers/}.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { closeOfficeStorage, setOfficeDataRoot } = await import('../src/control/officeStorage.js');
const { setTaskRuntime } = await import('../src/control/taskRunner.js');
const { ClaudeCliRuntime } = await import('../../runtime/src/index.js');
const { fakeClaude } = await import('./helpers/fakeClaude.js');

interface AgentDetailMessage {
  type: 'agentDetail';
  fileBacked?: boolean;
  agent: { id: string; name: string; role: string; systemPrompt: string; model?: string };
  skills: Array<{ id: string; agentId: string; slug: string; name: string; content?: string }>;
  knowledge: Array<{
    id: string;
    agentId: string;
    title: string;
    type: string;
    tags: string[];
    content?: string;
  }>;
}

interface ProjectDetailMessage {
  type: 'projectDetail';
  project: {
    id: string;
    name: string;
    description: string;
    status: string;
    workspacePaths: string[];
    defaultModel?: string;
  };
  memberships: Array<{ id: string; projectId: string; agentId: string }>;
  knowledge: Array<{
    id: string;
    projectId: string;
    title: string;
    type: string;
    tags: string[];
    content?: string;
  }>;
  tasks: Array<{
    id: string;
    projectId: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignedAgentId?: string;
    parentTaskId?: string;
    dependencies: string[];
    inputs: Array<{ kind: string; value?: string; knowledgeId?: string; path?: string }>;
  }>;
  sessions: Array<{
    id: string;
    agentId: string;
    projectId: string;
    taskId?: string;
    status: string;
    error?: string;
  }>;
  outputs: Array<{ id: string; taskId: string; sessionId?: string; title: string }>;
}

interface OfficeStateMessage {
  type: 'officeState';
  storage: { ready: boolean; schemaVersion: number; databasePath?: string; error?: string };
  projects: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; role: string; provider: string }>;
  memberships: Array<{ id: string; projectId: string; agentId: string }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  activeProjectId?: string;
}

/** A connected client that can send a command and await the resulting snapshot. */
class OfficeClient {
  private constructor(private readonly socket: WebSocket) {}

  static async connect(port: number, token: string): Promise<OfficeClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new OfficeClient(socket);
  }

  /** Send a command and resolve with the next officeState snapshot it produces. */
  async send(message: Record<string, unknown>): Promise<OfficeStateMessage> {
    const next = this.nextOfficeState();
    this.socket.send(JSON.stringify(message));
    return next;
  }

  /** Send a command and resolve with the agent configuration it produces. */
  async sendForDetail(message: Record<string, unknown>): Promise<AgentDetailMessage> {
    const next = this.next<AgentDetailMessage>('agentDetail');
    this.socket.send(JSON.stringify(message));
    return next;
  }

  /** Send a command and resolve with the project workspace it produces. */
  async sendForProject(message: Record<string, unknown>): Promise<ProjectDetailMessage> {
    const next = this.next<ProjectDetailMessage>('projectDetail');
    this.socket.send(JSON.stringify(message));
    return next;
  }

  nextProjectDetail(): Promise<ProjectDetailMessage> {
    return this.next<ProjectDetailMessage>('projectDetail');
  }

  /** Ask for one output's text and wait for it. */
  async outputContent(
    outputId: string,
  ): Promise<{ outputId: string; readable: boolean; content?: string }> {
    const next = this.next<{ outputId: string; readable: boolean; content?: string }>(
      'outputContent',
    );
    this.socket.send(JSON.stringify({ type: 'requestOutputContent', outputId }));
    return next;
  }

  nextOfficeState(): Promise<OfficeStateMessage> {
    return this.next<OfficeStateMessage>('officeState');
  }

  private next<T>(type: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        reject(new Error(`timed out waiting for ${type}`));
      }, 5000);
      const onMessage = (data: Buffer | string): void => {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type === type) {
          clearTimeout(timer);
          this.socket.off('message', onMessage);
          resolve(parsed as T);
        }
      };
      this.socket.on('message', onMessage);
    });
  }

  close(): void {
    this.socket.close();
  }
}

let server: InstanceType<typeof PixelAgentsServer>;
let dataRoot: string;

async function startServer(): Promise<{ port: number; token: string }> {
  server = new PixelAgentsServer();
  const config = await server.start({ store: new AgentStateStore(), embedded: false });
  return { port: config.port, token: config.token };
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-runtime-'));
  dataRoot = path.join(tmpBase, '.agent-office');
  setOfficeDataRoot(dataRoot);
});

afterEach(() => {
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  setTaskRuntime(undefined);
  server?.stop();
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('Agent Office runtime smoke test', () => {
  it('drives the whole vertical slice over the real WebSocket path', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);

    // 1-2. A fresh office opens its database and starts empty.
    const initial = await client.send({ type: 'requestOffice' });
    expect(initial.storage.ready).toBe(true);
    expect(initial.storage.schemaVersion).toBeGreaterThan(0);
    expect(initial.projects).toEqual([]);
    expect(initial.agents).toEqual([]);
    expect(initial.tasks).toEqual([]);

    // The database really is on disk, opened by the driver in the server process.
    expect(fs.existsSync(path.join(dataRoot, 'agent-office.db'))).toBe(true);

    // 3. Create a project. Creating it selects it.
    const withProject = await client.send({ type: 'createProject', name: 'AiWow' });
    expect(withProject.projects.map((p) => p.name)).toEqual(['AiWow']);
    const projectId = withProject.projects[0]!.id;
    expect(withProject.activeProjectId).toBe(projectId);

    // 4. Create a global agent.
    const withAgent = await client.send({
      type: 'createAgent',
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
    });
    expect(withAgent.agents.map((a) => a.name)).toEqual(['UX Agent']);
    const agentId = withAgent.agents[0]!.id;
    // Not a member yet.
    expect(withAgent.memberships).toEqual([]);

    // 5. Add it to the project.
    const withMember = await client.send({ type: 'addAgentToProject', projectId, agentId });
    expect(withMember.memberships.map((m) => m.agentId)).toEqual([agentId]);

    // 6. Create a task in that project.
    const withTask = await client.send({
      type: 'createTask',
      projectId,
      title: 'Map the onboarding flow',
    });
    expect(withTask.tasks.map((t) => t.title)).toEqual(['Map the onboarding flow']);

    // 8. Close the office.
    client.close();
    server.stop();
    closeOfficeStorage();

    // 9-10. Reopen it: a brand new server, a brand new client, the same data.
    setOfficeDataRoot(dataRoot);
    const restarted = await startServer();
    const reopened = await OfficeClient.connect(restarted.port, restarted.token);
    try {
      const afterRestart = await reopened.send({ type: 'requestOffice' });
      expect(afterRestart.storage.ready).toBe(true);
      expect(afterRestart.projects.map((p) => p.name)).toEqual(['AiWow']);
      expect(afterRestart.agents.map((a) => a.name)).toEqual(['UX Agent']);

      // Project-scoped lists need the selection, which is per-connection.
      const selected = await reopened.send({ type: 'setActiveProject', projectId });
      expect(selected.memberships.map((m) => m.agentId)).toEqual([agentId]);
      expect(selected.tasks.map((t) => t.title)).toEqual(['Map the onboarding flow']);
    } finally {
      reopened.close();
    }
  });

  it('configures an agent over the wire and finds it all again after a restart', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);

    // A global agent, created with no project in the office at all.
    const withAgent = await client.send({
      type: 'createAgent',
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
    });
    const agentId = withAgent.agents[0]!.id;
    expect(withAgent.projects).toEqual([]);

    // Open it: empty configuration to start with.
    const opened = await client.sendForDetail({ type: 'requestAgentDetail', agentId });
    expect(opened.skills).toEqual([]);
    expect(opened.knowledge).toEqual([]);

    // Edit the definition.
    const configured = await client.sendForDetail({
      type: 'updateAgent',
      agentId,
      name: 'UX Researcher',
      systemPrompt: 'Always cite the transcript.',
      model: 'claude-opus-5',
    });
    expect(configured.agent.name).toBe('UX Researcher');
    expect(configured.agent.systemPrompt).toBe('Always cite the transcript.');

    // Two skills, then edit one and delete the other.
    await client.sendForDetail({
      type: 'createSkill',
      agentId,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });
    const twoSkills = await client.sendForDetail({
      type: 'createSkill',
      agentId,
      slug: 'synthesis',
      name: 'Synthesise findings',
      kind: 'workflow',
    });
    expect(twoSkills.skills).toHaveLength(2);
    const interview = twoSkills.skills.find((s) => s.slug === 'interview')!;
    const synthesis = twoSkills.skills.find((s) => s.slug === 'synthesis')!;

    await client.sendForDetail({
      type: 'updateSkill',
      agentId,
      skillId: interview.id,
      name: 'Run a user interview',
      content: 'Ask open questions, then probe.',
    });
    const afterDelete = await client.sendForDetail({
      type: 'deleteSkill',
      agentId,
      skillId: synthesis.id,
    });
    expect(afterDelete.skills.map((s) => s.slug)).toEqual(['interview']);

    // Knowledge, added explicitly and then edited.
    const withKnowledge = await client.sendForDetail({
      type: 'createAgentKnowledge',
      agentId,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Start with context questions.',
      tags: ['research'],
    });
    expect(withKnowledge.knowledge).toHaveLength(1);
    const knowledgeId = withKnowledge.knowledge[0]!.id;
    await client.sendForDetail({
      type: 'updateAgentKnowledge',
      agentId,
      knowledgeId,
      title: 'Interview guide v2',
      content: 'Start with context, then tasks.',
    });

    // Close the office.
    client.close();
    server.stop();
    closeOfficeStorage();

    // Reopen: a new server, a new client, the same configuration.
    setOfficeDataRoot(dataRoot);
    const restarted = await startServer();
    const reopened = await OfficeClient.connect(restarted.port, restarted.token);
    try {
      const detail = await reopened.sendForDetail({ type: 'requestAgentDetail', agentId });
      expect(detail.agent.name).toBe('UX Researcher');
      expect(detail.agent.systemPrompt).toBe('Always cite the transcript.');
      expect(detail.agent.model).toBe('claude-opus-5');

      expect(detail.skills).toHaveLength(1);
      expect(detail.skills[0]!.name).toBe('Run a user interview');
      expect(detail.skills[0]!.content).toBe('Ask open questions, then probe.');
      expect(detail.skills[0]!.agentId).toBe(agentId);

      expect(detail.knowledge).toHaveLength(1);
      expect(detail.knowledge[0]!.title).toBe('Interview guide v2');
      expect(detail.knowledge[0]!.content).toBe('Start with context, then tasks.');
      expect(detail.knowledge[0]!.agentId).toBe(agentId);
    } finally {
      reopened.close();
    }
  });

  it('stores agent configuration in the agent-s own files, over the real path', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);

    const withAgent = await client.send({
      type: 'createAgent',
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
      systemPrompt: 'Cite the transcript.',
    });
    const agentId = withAgent.agents[0]!.id;

    await client.sendForDetail({
      type: 'createSkill',
      agentId,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      content: 'Ask open questions.',
    });
    const configured = await client.sendForDetail({
      type: 'createAgentKnowledge',
      agentId,
      title: 'Interview guide',
      knowledgeType: 'ux_research',
      content: 'Start with context questions.',
    });
    expect(configured.fileBacked).toBe(true);

    // The files really are on disk, written by the server process.
    const agentDir = path.join(dataRoot, 'agents', agentId);
    expect(fs.readFileSync(path.join(agentDir, 'instructions.md'), 'utf8')).toBe(
      'Cite the transcript.',
    );
    const skillDir = fs.readdirSync(path.join(agentDir, 'skills'))[0]!;
    expect(fs.readFileSync(path.join(agentDir, 'skills', skillDir, 'SKILL.md'), 'utf8')).toContain(
      'Ask open questions.',
    );
    const knowledgeFile = fs.readdirSync(path.join(agentDir, 'knowledge'))[0]!;
    expect(fs.readFileSync(path.join(agentDir, 'knowledge', knowledgeFile), 'utf8')).toContain(
      'Start with context questions.',
    );

    // Rename it: the directory is its id, so nothing moves.
    await client.sendForDetail({ type: 'updateAgent', agentId, name: 'Research Agent' });

    client.close();
    server.stop();
    closeOfficeStorage();

    // Reopen: a new server reads the same files.
    setOfficeDataRoot(dataRoot);
    const restarted = await startServer();
    const reopened = await OfficeClient.connect(restarted.port, restarted.token);
    try {
      const detail = await reopened.sendForDetail({ type: 'requestAgentDetail', agentId });
      expect(detail.agent.name).toBe('Research Agent');
      expect(detail.agent.systemPrompt).toBe('Cite the transcript.');
      expect(detail.skills[0]!.content).toBe('Ask open questions.');
      expect(detail.knowledge[0]!.content).toBe('Start with context questions.');
      expect(fs.existsSync(path.join(agentDir, 'instructions.md'))).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('refuses a duplicate skill slug and leaves the agent as it was', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);
    try {
      const withAgent = await client.send({
        type: 'createAgent',
        name: 'UX Agent',
        role: 'ux',
        provider: 'claude',
      });
      const agentId = withAgent.agents[0]!.id;
      await client.sendForDetail({
        type: 'createSkill',
        agentId,
        slug: 'interview',
        name: 'Run an interview',
        kind: 'workflow',
      });

      // The rejection still answers with the true configuration.
      const afterDuplicate = await client.sendForDetail({
        type: 'createSkill',
        agentId,
        slug: 'interview',
        name: 'Another',
        kind: 'workflow',
      });
      expect(afterDuplicate.skills).toHaveLength(1);
      expect(afterDuplicate.skills[0]!.name).toBe('Run an interview');
    } finally {
      client.close();
    }
  });

  it('prepares a whole project over the wire and finds it again after a restart', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);

    const withProject = await client.send({ type: 'createProject', name: 'AiWow' });
    const projectId = withProject.projects[0]!.id;
    const withAgent = await client.send({
      type: 'createAgent',
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
    });
    const agentId = withAgent.agents[0]!.id;
    await client.send({ type: 'addAgentToProject', projectId, agentId });

    // 1. Open the workspace and give the project its own context.
    const opened = await client.sendForProject({ type: 'requestProjectDetail', projectId });
    expect(opened.knowledge).toEqual([]);
    expect(opened.tasks).toEqual([]);

    const configured = await client.sendForProject({
      type: 'updateProject',
      projectId,
      description: 'Onboarding redesign',
      workspacePaths: ['/srv/aiwow'],
      defaultModel: 'claude-opus-5',
    });
    expect(configured.project.description).toBe('Onboarding redesign');

    // 2. Project knowledge.
    const withKnowledge = await client.sendForProject({
      type: 'createProjectKnowledge',
      projectId,
      title: 'Brand voice',
      knowledgeType: 'design_system',
      content: 'Plain and direct.',
      tags: ['brand'],
    });
    expect(withKnowledge.knowledge).toHaveLength(1);
    const knowledgeId = withKnowledge.knowledge[0]!.id;

    // 3. Many small tasks, most of them unassigned.
    let workspace = withKnowledge;
    for (const title of ['Research', 'Draft the copy', 'Review the copy']) {
      workspace = await client.sendForProject({ type: 'createTask', projectId, title });
    }
    expect(workspace.tasks).toHaveLength(3);
    expect(workspace.tasks.every((t) => t.assignedAgentId === undefined)).toBe(true);

    const research = workspace.tasks.find((t) => t.title === 'Research')!;
    const draft = workspace.tasks.find((t) => t.title === 'Draft the copy')!;
    const review = workspace.tasks.find((t) => t.title === 'Review the copy')!;

    // 4. Detail, dependencies, a decomposition parent and an input reference.
    const edited = await client.sendForProject({
      type: 'updateTask',
      taskId: draft.id,
      description: 'Done when the three screens read in one voice.',
      priority: 'high',
      parentTaskId: review.id,
      dependencies: [research.id],
      inputs: [
        { kind: 'projectKnowledge', knowledgeId },
        { kind: 'text', value: 'Under 40 words.' },
      ],
    });
    const editedDraft = edited.tasks.find((t) => t.id === draft.id)!;
    expect(editedDraft.dependencies).toEqual([research.id]);
    expect(editedDraft.parentTaskId).toBe(review.id);
    expect(editedDraft.inputs).toHaveLength(2);

    // 5. Assignment, and a status move the domain refuses.
    const assigned = await client.sendForProject({ type: 'assignTask', taskId: draft.id, agentId });
    expect(assigned.tasks.find((t) => t.id === draft.id)!.assignedAgentId).toBe(agentId);

    await client.sendForProject({ type: 'setTaskStatus', taskId: draft.id, status: 'todo' });
    const refused = await client.sendForProject({
      type: 'setTaskStatus',
      taskId: draft.id,
      status: 'in_progress',
    });
    // Research is not done, so the move did not happen — and the workspace that
    // comes back shows what is really stored.
    expect(refused.tasks.find((t) => t.id === draft.id)!.status).toBe('todo');

    // 6. Close the office.
    client.close();
    server.stop();
    closeOfficeStorage();

    // 7. Reopen: new server, new client, same workspace.
    setOfficeDataRoot(dataRoot);
    const restarted = await startServer();
    const reopened = await OfficeClient.connect(restarted.port, restarted.token);
    try {
      const detail = await reopened.sendForProject({ type: 'requestProjectDetail', projectId });
      expect(detail.project.description).toBe('Onboarding redesign');
      expect(detail.project.workspacePaths).toEqual(['/srv/aiwow']);
      expect(detail.project.defaultModel).toBe('claude-opus-5');

      expect(detail.knowledge).toHaveLength(1);
      expect(detail.knowledge[0]!.title).toBe('Brand voice');
      expect(detail.knowledge[0]!.content).toBe('Plain and direct.');
      expect(detail.knowledge[0]!.projectId).toBe(projectId);

      expect(detail.tasks).toHaveLength(3);
      const storedDraft = detail.tasks.find((t) => t.id === draft.id)!;
      expect(storedDraft.description).toBe('Done when the three screens read in one voice.');
      expect(storedDraft.priority).toBe('high');
      expect(storedDraft.status).toBe('todo');
      expect(storedDraft.assignedAgentId).toBe(agentId);
      expect(storedDraft.parentTaskId).toBe(review.id);
      expect(storedDraft.dependencies).toEqual([research.id]);
      expect(storedDraft.inputs).toEqual([
        { kind: 'projectKnowledge', knowledgeId },
        { kind: 'text', value: 'Under 40 words.' },
      ]);
      expect(detail.tasks.filter((t) => t.assignedAgentId === undefined)).toHaveLength(2);

      // The agent's own configuration was never touched by any of it.
      const agentDetail = await reopened.sendForDetail({ type: 'requestAgentDetail', agentId });
      expect(agentDetail.skills).toEqual([]);
      expect(agentDetail.knowledge).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('refuses to assign a task to an agent outside the project', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);
    try {
      const withProject = await client.send({ type: 'createProject', name: 'AiWow' });
      const projectId = withProject.projects[0]!.id;
      const withAgent = await client.send({
        type: 'createAgent',
        name: 'Outsider',
        role: 'qa',
        provider: 'claude',
      });
      const agentId = withAgent.agents[0]!.id;
      await client.sendForProject({ type: 'requestProjectDetail', projectId });
      const withTask = await client.sendForProject({
        type: 'createTask',
        projectId,
        title: 'Draft the copy',
      });
      const taskId = withTask.tasks[0]!.id;

      const refused = await client.sendForProject({ type: 'assignTask', taskId, agentId });
      expect(refused.tasks[0]!.assignedAgentId).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('runs a task over the real WebSocket path and returns its result', async () => {
    // Only the `claude` process is a stand-in; the server, the socket, the
    // bridge and the database are all real.
    const claude = fakeClaude();
    claude.script = { result: 'Welcome aboard.' };
    // A sandboxed run authenticates from the environment.
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token';
    setTaskRuntime(new ClaudeCliRuntime({ spawn: claude.spawn }));

    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);

    const withProject = await client.send({ type: 'createProject', name: 'AiWow' });
    const projectId = withProject.projects[0]!.id;
    const withAgent = await client.send({
      type: 'createAgent',
      name: 'UX Agent',
      role: 'ux',
      provider: 'claude',
    });
    const agentId = withAgent.agents[0]!.id;
    await client.send({ type: 'addAgentToProject', projectId, agentId });
    await client.sendForProject({ type: 'requestProjectDetail', projectId });
    const withTask = await client.sendForProject({
      type: 'createTask',
      projectId,
      title: 'Draft the welcome copy',
      assignedAgentId: agentId,
    });
    const taskId = withTask.tasks[0]!.id;
    await client.sendForProject({ type: 'setTaskStatus', taskId, status: 'todo' });

    // Run it. The workspace is pushed again as the run starts and as it ends.
    const running = await client.sendForProject({ type: 'runTask', taskId });
    expect(running.sessions[0]!.taskId).toBe(taskId);

    let finished = running;
    for (let i = 0; i < 20 && finished.sessions[0]!.status !== 'ended'; i++) {
      finished = await client.nextProjectDetail();
    }
    expect(finished.sessions[0]!.status).toBe('ended');
    expect(finished.tasks.find((t) => t.id === taskId)!.status).toBe('review');
    expect(finished.outputs).toHaveLength(1);

    // The result text is fetched on demand.
    const content = await client.outputContent(finished.outputs[0]!.id);
    expect(content.readable).toBe(true);
    expect(content.content).toBe('Welcome aboard.');

    client.close();
  });

  it('removes a membership without deleting the global agent', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);
    try {
      const withProject = await client.send({ type: 'createProject', name: 'AiWow' });
      const projectId = withProject.projects[0]!.id;
      const withAgent = await client.send({
        type: 'createAgent',
        name: 'UX Agent',
        role: 'ux',
        provider: 'claude',
      });
      const agentId = withAgent.agents[0]!.id;
      await client.send({ type: 'addAgentToProject', projectId, agentId });

      const removed = await client.send({ type: 'removeAgentFromProject', projectId, agentId });
      expect(removed.memberships).toEqual([]);
      // The agent is still in the library.
      expect(removed.agents.map((a) => a.id)).toEqual([agentId]);
    } finally {
      client.close();
    }
  });

  it('reports a rejected operation without losing the real state', async () => {
    const { port, token } = await startServer();
    const client = await OfficeClient.connect(port, token);
    try {
      const withProject = await client.send({ type: 'createProject', name: 'AiWow' });
      const projectId = withProject.projects[0]!.id;
      const withAgent = await client.send({
        type: 'createAgent',
        name: 'UX Agent',
        role: 'ux',
        provider: 'claude',
      });
      const agentId = withAgent.agents[0]!.id;
      await client.send({ type: 'addAgentToProject', projectId, agentId });

      // A duplicate membership is refused, and the snapshot that follows still
      // shows the one real membership.
      const afterDuplicate = await client.send({
        type: 'addAgentToProject',
        projectId,
        agentId,
      });
      expect(afterDuplicate.memberships).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});

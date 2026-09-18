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

interface AgentDetailMessage {
  type: 'agentDetail';
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
      skillId: interview.id,
      name: 'Run a user interview',
      content: 'Ask open questions, then probe.',
    });
    const afterDelete = await client.sendForDetail({
      type: 'deleteSkill',
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

/**
 * What happens to an Agent's files AFTER the first migration.
 *
 * The first migration passing proves very little on its own: the questions
 * that matter are whether an ordinary edit survives a restart, whether a
 * deletion stays deleted, whether the legacy rows can come back and overwrite
 * newer files, and what the office does when a file-backed agent's files are
 * gone. Everything here runs through the real server, the real WebSocket and a
 * real database on disk.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
const { openSqliteStorage } = await import('../../storage/src/index.js');
const { createAgentDefinition, createAgentKnowledge, createSkill, systemClock, uuidIdGenerator } =
  await import('../../domain/src/index.js');

const DEPS = { ids: uuidIdGenerator, clock: systemClock };

interface AgentDetailMessage {
  type: 'agentDetail';
  fileBacked?: boolean;
  configIssue?: string;
  agent: { id: string; name: string; systemPrompt?: string };
  skills: Array<{ id: string; slug: string; name: string; content?: string }>;
  knowledge: Array<{ id: string; title: string; content?: string }>;
}

interface OfficeErrorMessage {
  type: 'officeError';
  operation: string;
  message: string;
}

class Client {
  private constructor(private readonly socket: WebSocket) {}

  static async connect(port: number, token: string): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Client(socket);
  }

  /** Send a command and resolve with the agent configuration it produces. */
  async detail(message: Record<string, unknown>): Promise<AgentDetailMessage> {
    const next = this.next<AgentDetailMessage>('agentDetail');
    this.socket.send(JSON.stringify(message));
    return next;
  }

  /** Send a command expected to be refused, and resolve with the refusal. */
  async failure(message: Record<string, unknown>): Promise<OfficeErrorMessage> {
    const next = this.next<OfficeErrorMessage>('officeError');
    this.socket.send(JSON.stringify(message));
    return next;
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

let server: InstanceType<typeof PixelAgentsServer> | undefined;
let dataRoot: string;

async function startServer(): Promise<Client> {
  setOfficeDataRoot(dataRoot);
  server = new PixelAgentsServer();
  const config = await server.start({ store: new AgentStateStore(), embedded: false });
  return Client.connect(config.port, config.token);
}

function stopServer(client?: Client): void {
  client?.close();
  server?.stop();
  server = undefined;
  closeOfficeStorage();
}

/** An agent that exists only in the database, the way a pre-M5 office had it. */
async function seedLegacyAgent(): Promise<{
  agentId: string;
  skillId: string;
  knowledgeId: string;
}> {
  const storage = openSqliteStorage({ dataRoot });
  try {
    const agent = createAgentDefinition(
      { name: 'UX Agent', role: 'ux', provider: 'claude', systemPrompt: 'LEGACY INSTRUCTIONS' },
      DEPS,
    );
    await storage.repos.agents.put(agent);

    const skill = createSkill(
      {
        agentId: agent.id,
        slug: 'interview',
        name: 'Run an interview',
        kind: 'workflow',
        source: { origin: 'content', ref: { store: 'inline', content: 'LEGACY SKILL BODY' } },
      },
      DEPS,
    );
    await storage.repos.skills.put(skill);

    const location = await storage.repos.blobs.write(
      { owner: { kind: 'agent', agentId: agent.id }, name: 'guide.md' },
      'LEGACY KNOWLEDGE',
    );
    const item = createAgentKnowledge(
      {
        agentId: agent.id,
        type: 'ux_research',
        title: 'Interview guide',
        source: { origin: 'human' },
        location,
      },
      DEPS,
    );
    await storage.repos.agentKnowledge.put(item);
    return { agentId: agent.id, skillId: skill.id, knowledgeId: item.id };
  } finally {
    storage.close();
  }
}

/** Copy the three things a backup covers, with the office stopped. */
function backup(to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of ['agent-office.db', 'blobs', 'agents']) {
    fs.cpSync(path.join(dataRoot, entry), path.join(to, entry), { recursive: true });
  }
}

function restore(from: string): void {
  for (const entry of ['agent-office.db', 'blobs', 'agents']) {
    fs.rmSync(path.join(dataRoot, entry), { recursive: true, force: true });
    fs.cpSync(path.join(from, entry), path.join(dataRoot, entry), { recursive: true });
  }
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-lifecycle-'));
  dataRoot = path.join(tmpBase, '.agent-office');
  setOfficeDataRoot(dataRoot);
});

afterEach(() => {
  stopServer();
  setOfficeDataRoot(undefined);
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('agent files after migration, over the real path', () => {
  it('migrates, then keeps edits, additions and deletions across a restart', async () => {
    const legacy = await seedLegacyAgent();

    // ── First start: the agent moves to files ──
    let client = await startServer();
    let detail = await client.detail({ type: 'requestAgentDetail', agentId: legacy.agentId });
    expect(detail.fileBacked).toBe(true);
    expect(detail.agent.systemPrompt).toBe('LEGACY INSTRUCTIONS');
    expect(detail.skills.map((s) => s.slug)).toEqual(['interview']);
    expect(detail.knowledge.map((k) => k.title)).toEqual(['Interview guide']);

    // ── Edit what came from the database ──
    detail = await client.detail({
      type: 'updateAgent',
      agentId: legacy.agentId,
      systemPrompt: 'EDITED INSTRUCTIONS',
    });
    expect(detail.agent.systemPrompt).toContain('EDITED INSTRUCTIONS');

    // ── Add things that exist only as files ──
    detail = await client.detail({
      type: 'createSkill',
      agentId: legacy.agentId,
      slug: 'synthesis',
      name: 'Synthesise findings',
      kind: 'workflow',
      content: 'FILE-ONLY SKILL',
    });
    detail = await client.detail({
      type: 'createAgentKnowledge',
      agentId: legacy.agentId,
      title: 'File-only note',
      knowledgeType: 'markdown',
      content: 'FILE-ONLY KNOWLEDGE',
    });
    expect(detail.skills).toHaveLength(2);
    expect(detail.knowledge).toHaveLength(2);

    // ── Delete what the migration brought over ──
    detail = await client.detail({
      type: 'deleteSkill',
      agentId: legacy.agentId,
      skillId: legacy.skillId,
    });
    const migratedKnowledge = detail.knowledge.find((k) => k.title === 'Interview guide')!;
    detail = await client.detail({
      type: 'deleteAgentKnowledge',
      agentId: legacy.agentId,
      knowledgeId: migratedKnowledge.id,
    });
    expect(detail.skills.map((s) => s.slug)).toEqual(['synthesis']);
    expect(detail.knowledge.map((k) => k.title)).toEqual(['File-only note']);

    // ── Restart the real server ──
    stopServer(client);
    client = await startServer();
    detail = await client.detail({ type: 'requestAgentDetail', agentId: legacy.agentId });

    // The edit survived, the addition survived, and the legacy rows did NOT
    // come back over them.
    expect(detail.fileBacked).toBe(true);
    expect(detail.configIssue).toBeUndefined();
    expect(detail.agent.systemPrompt).toContain('EDITED INSTRUCTIONS');
    expect(detail.skills.map((s) => s.slug)).toEqual(['synthesis']);
    expect(detail.skills[0]!.content).toBe('FILE-ONLY SKILL');
    expect(detail.knowledge.map((k) => k.title)).toEqual(['File-only note']);
    expect(detail.knowledge[0]!.content).toBe('FILE-ONLY KNOWLEDGE');
    stopServer(client);
  });

  it('reports missing files instead of quietly serving the old database', async () => {
    const legacy = await seedLegacyAgent();
    let client = await startServer();
    await client.detail({
      type: 'updateAgent',
      agentId: legacy.agentId,
      systemPrompt: 'EDITED INSTRUCTIONS',
    });
    stopServer(client);

    // The agents tree is lost — a bad restore, a stray rm, a broken disk.
    fs.rmSync(path.join(dataRoot, 'agents'), { recursive: true, force: true });

    client = await startServer();
    const detail = await client.detail({ type: 'requestAgentDetail', agentId: legacy.agentId });
    // Not presented as a working agent, and NOT rebuilt from the legacy rows.
    expect(detail.fileBacked).toBe(false);
    expect(detail.configIssue).toMatch(/missing or unreadable/i);
    expect(detail.agent.systemPrompt).not.toBe('LEGACY INSTRUCTIONS');
    expect(detail.skills).toEqual([]);

    // Editing is refused rather than writing over what may still be recoverable.
    const refusal = await client.failure({
      type: 'updateAgent',
      agentId: legacy.agentId,
      systemPrompt: 'do not write this',
    });
    expect(refusal.message).toMatch(/restore the agents directory from a backup/i);
    stopServer(client);
  });

  it('comes back intact from a stopped-office backup', async () => {
    const legacy = await seedLegacyAgent();
    let client = await startServer();
    await client.detail({
      type: 'updateAgent',
      agentId: legacy.agentId,
      systemPrompt: 'EDITED INSTRUCTIONS',
    });
    await client.detail({
      type: 'createSkill',
      agentId: legacy.agentId,
      slug: 'synthesis',
      name: 'Synthesise findings',
      kind: 'workflow',
      content: 'FILE-ONLY SKILL',
    });
    await client.detail({
      type: 'deleteSkill',
      agentId: legacy.agentId,
      skillId: legacy.skillId,
    });

    // Stop the office, then copy the three paths.
    stopServer(client);
    const vault = path.join(tmpBase, 'backup');
    backup(vault);

    // Lose everything, restore, restart.
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    restore(vault);

    client = await startServer();
    const detail = await client.detail({ type: 'requestAgentDetail', agentId: legacy.agentId });
    expect(detail.fileBacked).toBe(true);
    expect(detail.configIssue).toBeUndefined();
    // Edited, added and deleted state all came back as they were.
    expect(detail.agent.systemPrompt).toContain('EDITED INSTRUCTIONS');
    expect(detail.skills.map((s) => s.slug)).toEqual(['synthesis']);
    expect(detail.knowledge.map((k) => k.title)).toEqual(['Interview guide']);
    stopServer(client);
  });

  it('refuses an agent-scoped mutation that names no agent', async () => {
    const legacy = await seedLegacyAgent();
    const client = await startServer();
    await client.detail({ type: 'requestAgentDetail', agentId: legacy.agentId });

    const refusal = await client.failure({ type: 'deleteSkill', skillId: legacy.skillId });
    expect(refusal.operation).toBe('deleteSkill');
    expect(refusal.message).toBeTruthy();

    // The skill is untouched: a call with no owner changes nothing.
    const detail = await client.detail({ type: 'requestAgentDetail', agentId: legacy.agentId });
    expect(detail.skills.map((s) => s.id)).toEqual([legacy.skillId]);
    stopServer(client);
  });
});

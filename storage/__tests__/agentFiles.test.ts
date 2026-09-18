/**
 * Agent-owned file storage and the migration into it.
 *
 * What matters here is what the files ARE — identity by id, isolation between
 * agents, and a migration that never destroys what it is moving.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentId, AgentKnowledge, Skill } from '../../domain/src/index.js';
import {
  createAgentDefinition,
  createAgentKnowledge,
  createSkill,
  systemClock,
  uuidIdGenerator,
} from '../../domain/src/index.js';
import type { SqliteStorage } from '../src/index.js';
import { migrateAgentFiles, openSqliteStorage } from '../src/index.js';

const DEPS = { ids: uuidIdGenerator, clock: systemClock };
const NOW = '2026-09-18T00:00:00.000Z';

let dataRoot: string;
let storage: SqliteStorage;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-files-'));
  storage = openSqliteStorage({ dataRoot });
});

afterEach(() => {
  storage.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function agentsRoot(): string {
  return path.join(dataRoot, 'agents');
}

/** An agent in the database, with a skill and a knowledge item, pre-M5 style. */
async function legacyAgent(name = 'UX Agent'): Promise<{
  agentId: AgentId;
  skill: Skill;
  knowledge: AgentKnowledge;
}> {
  const agent = createAgentDefinition(
    { name, role: 'ux', provider: 'claude', systemPrompt: 'Cite the transcript.' },
    DEPS,
  );
  await storage.repos.agents.put(agent);

  const skill = createSkill(
    {
      agentId: agent.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      description: 'Semi-structured',
      source: { origin: 'content', ref: { store: 'inline', content: 'Ask open questions.' } },
      requiredTools: ['Read'],
    },
    DEPS,
  );
  await storage.repos.skills.put(skill);

  const location = await storage.repos.blobs.write(
    { owner: { kind: 'agent', agentId: agent.id }, name: 'guide.md' },
    'AGENT-KNOWLEDGE-BODY',
  );
  const knowledge = createAgentKnowledge(
    {
      agentId: agent.id,
      type: 'ux_research',
      title: 'Interview guide',
      source: { origin: 'human' },
      location,
    },
    DEPS,
  );
  await storage.repos.agentKnowledge.put(knowledge);
  return { agentId: agent.id, skill, knowledge };
}

describe('agent file storage', () => {
  it('gives an agent a directory named by its id, not its name', async () => {
    const { agentId } = await legacyAgent();
    await storage.agentFiles.ensureAgent(agentId, NOW);

    expect(fs.existsSync(path.join(agentsRoot(), agentId, 'agent.json'))).toBe(true);
    // Nothing in the tree is named after the agent.
    expect(fs.readdirSync(agentsRoot())).toEqual([agentId]);
  });

  it('keeps every resource when the agent is renamed', async () => {
    const { agentId } = await legacyAgent();
    await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);

    const agent = (await storage.repos.agents.get(agentId))!;
    await storage.repos.agents.put({ ...agent, name: 'Research Agent' });

    // The directory is the id, so a rename moves nothing.
    expect(await storage.agentFiles.readInstructions(agentId)).toBe('Cite the transcript.');
    expect(await storage.agentFiles.listSkills(agentId)).toHaveLength(1);
    expect(await storage.agentFiles.listKnowledge(agentId)).toHaveLength(1);
  });

  it('refuses ids that are not canonical uuids', async () => {
    const { agentId } = await legacyAgent();
    await storage.agentFiles.ensureAgent(agentId, NOW);

    for (const bad of ['../escape', '..', '/etc/passwd', 'a/../../b', 'not-a-uuid', '']) {
      await expect(storage.agentFiles.readSkill(agentId, bad)).rejects.toThrow(/canonical uuid/);
      await expect(storage.agentFiles.readKnowledge(agentId, bad)).rejects.toThrow(
        /canonical uuid/,
      );
      await expect(storage.agentFiles.readInstructions(bad as AgentId)).rejects.toThrow(
        /canonical uuid/,
      );
    }
    // And nothing escaped.
    expect(fs.readdirSync(agentsRoot())).toEqual([agentId]);
  });

  it('will not hand one agent another agent-s file', async () => {
    const one = await legacyAgent('One');
    const two = await legacyAgent('Two');
    await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);

    // Asking for the other agent's skill id under this agent finds nothing:
    // every path is built from the OWNER's id.
    expect(await storage.agentFiles.readSkill(one.agentId, two.skill.id)).toBeNull();
    expect(await storage.agentFiles.readKnowledge(one.agentId, two.knowledge.id)).toBeNull();
    expect(await storage.agentFiles.deleteSkill(one.agentId, two.skill.id)).toBe(false);
    // The real owner still has it.
    expect(await storage.agentFiles.readSkill(two.agentId, two.skill.id)).not.toBeNull();
  });
});

describe('agent file migration', () => {
  it('moves instructions, skills and knowledge without touching the originals', async () => {
    const { agentId, skill, knowledge } = await legacyAgent();

    const report = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);
    expect(report.conflicts).toEqual([]);
    expect(report.migrated).toEqual([agentId]);
    expect(report.written).toBe(3);

    expect(await storage.agentFiles.readInstructions(agentId)).toBe('Cite the transcript.');
    const storedSkill = (await storage.agentFiles.readSkill(agentId, skill.id))!;
    expect(storedSkill.skill.slug).toBe('interview');
    expect(storedSkill.skill.requiredTools).toEqual(['Read']);
    expect(storedSkill.content).toBe('Ask open questions.');
    const storedKnowledge = (await storage.agentFiles.readKnowledge(agentId, knowledge.id))!;
    expect(storedKnowledge.item.title).toBe('Interview guide');
    expect(storedKnowledge.content).toBe('AGENT-KNOWLEDGE-BODY');

    // The legacy copies are all still there, untouched.
    expect(await storage.repos.skills.get(skill.id)).toEqual(skill);
    expect(await storage.repos.agentKnowledge.get(knowledge.id)).toEqual(knowledge);
    expect(await storage.repos.blobs.read(knowledge.location)).toBe('AGENT-KNOWLEDGE-BODY');
  });

  it('is idempotent', async () => {
    await legacyAgent();
    const first = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);
    const second = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);

    expect(first.written).toBe(3);
    // Second run writes nothing and reports the same agent as done.
    expect(second.written).toBe(0);
    expect(second.conflicts).toEqual([]);
    expect(second.migrated).toEqual(first.migrated);
  });

  it('resumes an interrupted run', async () => {
    const { agentId, skill, knowledge } = await legacyAgent();

    // Simulate a crash after the instructions were written and before the rest:
    // the marker is absent, so the agent is not yet authoritative.
    await storage.agentFiles.ensureAgent(agentId, NOW);
    await storage.agentFiles.writeInstructions(agentId, 'Cite the transcript.');
    expect(await storage.agentFiles.isMigrated(agentId)).toBe(false);

    const report = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);
    expect(report.conflicts).toEqual([]);
    expect(report.migrated).toEqual([agentId]);
    // Only the two missing resources were written the second time.
    expect(report.written).toBe(2);
    expect(await storage.agentFiles.readSkill(agentId, skill.id)).not.toBeNull();
    expect(await storage.agentFiles.readKnowledge(agentId, knowledge.id)).not.toBeNull();
  });

  it('reports a conflict and overwrites nothing', async () => {
    const { agentId, knowledge } = await legacyAgent();
    await storage.agentFiles.ensureAgent(agentId, NOW);
    await storage.agentFiles.writeInstructions(agentId, 'HAND-EDITED INSTRUCTIONS');

    const report = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);

    expect(report.conflicts.map((c) => c.resource)).toContain('instructions');
    expect(report.blocked).toEqual([agentId]);
    expect(report.migrated).toEqual([]);
    // Both copies survive: the file as the person left it...
    expect(await storage.agentFiles.readInstructions(agentId)).toBe('HAND-EDITED INSTRUCTIONS');
    // ...and the database as it was.
    expect((await storage.repos.agents.get(agentId))!.systemPrompt).toBe('Cite the transcript.');
    expect(await storage.repos.blobs.read(knowledge.location)).toBe('AGENT-KNOWLEDGE-BODY');
    // Not authoritative, so nothing reads the files for this agent yet.
    expect(await storage.agentFiles.isMigrated(agentId)).toBe(false);
  });

  it('refuses to migrate knowledge whose content cannot be read', async () => {
    const { agentId, knowledge } = await legacyAgent();
    // The blob is gone; migrating would write an empty file over nothing.
    await storage.repos.blobs.delete(knowledge.location);

    const report = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);
    expect(report.blocked).toEqual([agentId]);
    expect(report.conflicts.some((c) => c.resource === 'knowledge')).toBe(true);
    expect(await storage.agentFiles.readKnowledge(agentId, knowledge.id)).toBeNull();
  });

  it('recovers by deleting the files: the database still has everything', async () => {
    const { agentId, skill, knowledge } = await legacyAgent();
    await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);

    // Rollback is deleting the agent tree; the legacy rows never moved.
    fs.rmSync(path.join(agentsRoot(), agentId), { recursive: true, force: true });
    expect(await storage.agentFiles.isMigrated(agentId)).toBe(false);
    expect((await storage.repos.agents.get(agentId))!.systemPrompt).toBe('Cite the transcript.');
    expect(await storage.repos.skills.get(skill.id)).not.toBeNull();
    expect(await storage.repos.blobs.read(knowledge.location)).toBe('AGENT-KNOWLEDGE-BODY');

    // And running the migration again rebuilds the files from them.
    const again = await migrateAgentFiles(storage.repos, storage.agentFiles, NOW);
    expect(again.written).toBe(3);
    expect(again.conflicts).toEqual([]);
  });
});

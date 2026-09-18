/**
 * The SQLite adapter.
 *
 * It runs the SAME contract suite as the in-memory adapter, unmodified — that
 * is the point of the contract. Everything below the contract run is specific
 * to persistence: things an in-memory store cannot be asked to prove.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentDefinition, DomainDeps, Project } from '../../domain/src/index.js';
import {
  createAgentDefinition,
  createAgentKnowledge,
  createProject,
  createProjectAgent,
  createProjectKnowledge,
  createSkill,
  createTask,
  KnowledgeType,
  SkillKind,
  startSession,
} from '../../domain/src/index.js';
import type { SqliteStorage } from '../src/index.js';
import {
  LATEST_SCHEMA_VERSION,
  migrate,
  MIGRATIONS,
  openSqliteStorage,
  SqliteDatabase,
} from '../src/index.js';
import { describeRepositoryContract } from './repositoryContract.js';

// ── Test fixtures ────────────────────────────────────────────────

const roots: string[] = [];

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-sqlite-'));
  roots.push(root);
  return root;
}

function testDeps(prefix = 1): DomainDeps {
  let n = 0;
  let clock = Date.UTC(2026, 0, 1);
  return {
    ids: {
      next(): string {
        n += 1;
        return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${n
          .toString(16)
          .padStart(12, '0')}`;
      },
    },
    clock: {
      now(): string {
        const value = new Date(clock).toISOString();
        clock += 1000;
        return value;
      },
    },
  };
}

// Temp databases are per-test; this removes the directories at the end so a
// test run leaves nothing behind in the system temp dir.
afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The contract suite gets a throwaway on-disk database per test, so it
// exercises real SQL, real foreign keys and real transactions.
describeRepositoryContract({
  name: 'sqlite',
  create: () => {
    const storage = openSqliteStorage({ dataRoot: freshRoot() });
    return { repos: storage.repos, uow: storage.uow };
  },
});

describe('sqlite adapter', () => {
  let root: string;
  let storage: SqliteStorage;
  let deps: DomainDeps;

  beforeEach(() => {
    root = freshRoot();
    storage = openSqliteStorage({ dataRoot: root });
    deps = testDeps();
  });

  afterEach(() => {
    if (storage.db.isOpen()) {
      storage.close();
    }
  });

  async function seedProject(name: string): Promise<Project> {
    const project = createProject({ name }, deps);
    await storage.repos.projects.put(project);
    return project;
  }

  async function seedAgent(role: string): Promise<AgentDefinition> {
    const agent = createAgentDefinition({ name: `${role} Agent`, role, provider: 'claude' }, deps);
    await storage.repos.agents.put(agent);
    return agent;
  }

  // ── 1. Persistence across close + reopen ───────────────────────

  describe('persistence', () => {
    it('survives close and reopen', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      const membership = createProjectAgent(
        { projectId: project.id, agentId: agent.id, seatId: 'desk-1' },
        deps,
      );
      await storage.repos.projectAgents.put(membership);
      const skill = createSkill(
        {
          agentId: agent.id,
          slug: 'user-research',
          name: 'User Research',
          kind: SkillKind.WORKFLOW,
          source: { origin: 'content', ref: { store: 'inline', content: '# steps' } },
          requiredTools: ['Read'],
        },
        deps,
      );
      await storage.repos.skills.put(skill);
      const task = createTask(
        { projectId: project.id, title: 'Map the flow', assignedAgentId: agent.id },
        deps,
      );
      await storage.repos.tasks.put(task);
      const session = startSession(
        { agentId: agent.id, projectId: project.id, provider: 'claude', taskId: task.id },
        deps,
      );
      await storage.repos.sessions.put(session);

      storage.close();

      // A completely new process would do exactly this.
      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        expect(await reopened.repos.projects.get(project.id)).toEqual(project);
        expect(await reopened.repos.agents.get(agent.id)).toEqual(agent);
        expect(await reopened.repos.skills.get(skill.id)).toEqual(skill);
        expect(await reopened.repos.tasks.get(task.id)).toEqual(task);
        expect(await reopened.repos.sessions.get(session.id)).toEqual(session);
        expect((await reopened.repos.projectAgents.get(membership.id))?.seatId).toBe('desk-1');
      } finally {
        reopened.close();
      }
    });

    it('keeps blob content on the filesystem, not in the database', async () => {
      const project = await seedProject('AiWow');
      const ref = await storage.repos.blobs.write(
        { owner: { kind: 'project', projectId: project.id }, name: 'prd.md' },
        '# PRD',
      );
      storage.close();

      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        expect(await reopened.repos.blobs.read(ref)).toBe('# PRD');
      } finally {
        reopened.close();
      }

      // The bytes live under blobs/, addressed by owner kind.
      expect(ref).toMatchObject({ store: 'blob' });
      if (ref.store === 'blob') {
        expect(ref.key.startsWith(`project/${project.id}/`)).toBe(true);
        expect(fs.existsSync(path.join(root, 'blobs', ref.key))).toBe(true);
      }
    });

    it('does not reuse blob keys after reopening', async () => {
      const agent = await seedAgent('ux');
      const first = await storage.repos.blobs.write(
        { owner: { kind: 'agent', agentId: agent.id }, name: 'notes.md' },
        'one',
      );
      storage.close();

      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        const second = await reopened.repos.blobs.write(
          { owner: { kind: 'agent', agentId: agent.id }, name: 'notes.md' },
          'two',
        );
        expect(second).not.toEqual(first);
        expect(await reopened.repos.blobs.read(first)).toBe('one');
        expect(await reopened.repos.blobs.read(second)).toBe('two');
      } finally {
        reopened.close();
      }
    });
  });

  // ── 9. A new database is empty ─────────────────────────────────

  describe('initialisation', () => {
    it('creates a database that is entirely empty', async () => {
      const fresh = openSqliteStorage({ dataRoot: freshRoot() });
      try {
        expect(await fresh.repos.projects.list()).toEqual([]);
        expect(await fresh.repos.agents.list()).toEqual([]);
        // A file created from nothing runs every migration, in order.
        expect(fresh.applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
        expect(fresh.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

        // Every table, checked directly: no seed rows anywhere.
        const tables = fresh.db
          .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .map((row) => String(row['name']));
        expect(tables.length).toBeGreaterThan(0);
        for (const table of tables) {
          const count = Number(fresh.db.get(`SELECT COUNT(*) AS n FROM "${table}"`)?.['n']);
          expect({ table, count }).toEqual({ table, count: 0 });
        }
      } finally {
        fresh.close();
      }
    });

    it('creates the data root when it does not exist', () => {
      const missing = path.join(freshRoot(), 'nested', 'deeper');
      const fresh = openSqliteStorage({ dataRoot: missing });
      try {
        expect(fs.existsSync(path.join(missing, 'agent-office.db'))).toBe(true);
        expect(fs.existsSync(path.join(missing, 'blobs'))).toBe(true);
      } finally {
        fresh.close();
      }
    });

    it('applies no migrations to an already-current database', () => {
      const dir = freshRoot();
      openSqliteStorage({ dataRoot: dir }).close();
      const again = openSqliteStorage({ dataRoot: dir });
      try {
        expect(again.applied).toEqual([]);
        expect(again.db.userVersion).toBe(LATEST_SCHEMA_VERSION);
      } finally {
        again.close();
      }
    });

    it('refuses a database written by a newer build', () => {
      const file = path.join(freshRoot(), 'future.db');
      const db = new SqliteDatabase({ path: file });
      db.setUserVersion(LATEST_SCHEMA_VERSION + 1);
      db.close();

      expect(() => openSqliteStorage({ dataRoot: freshRoot(), databasePath: file })).toThrow(
        /newer than this build supports/,
      );
    });

    it('leaves no schema behind when a migration fails', () => {
      const db = new SqliteDatabase({ path: ':memory:' });
      try {
        // A table the first migration also creates, so migration 1 collides.
        db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
        expect(() => migrate(db)).toThrow();
        // Rolled back: the version never advanced.
        expect(db.userVersion).toBe(0);
        expect(db.get("SELECT name FROM sqlite_master WHERE name = 'agents'")).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  // ── 2, 3, 4, 5. Ownership boundaries, enforced by the schema ───

  describe('ownership boundaries survive persistence', () => {
    it('lets one agent belong to multiple projects across a reopen', async () => {
      const alpha = await seedProject('Alpha');
      const beta = await seedProject('Beta');
      const agent = await seedAgent('ux');
      await storage.repos.projectAgents.put(
        createProjectAgent({ projectId: alpha.id, agentId: agent.id }, deps),
      );
      await storage.repos.projectAgents.put(
        createProjectAgent({ projectId: beta.id, agentId: agent.id }, deps),
      );
      storage.close();

      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        expect(await reopened.repos.projectAgents.listByAgent(agent.id)).toHaveLength(2);
        // One definition, two memberships.
        expect(await reopened.repos.agents.list()).toHaveLength(1);
        expect(await reopened.repos.projectAgents.find(alpha.id, agent.id)).not.toBeNull();
        expect(await reopened.repos.projectAgents.find(beta.id, agent.id)).not.toBeNull();
      } finally {
        reopened.close();
      }
    });

    it('enforces membership uniqueness at the database level', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      await storage.repos.projectAgents.put(
        createProjectAgent({ projectId: project.id, agentId: agent.id }, deps),
      );

      // A second membership for the same pair, with a different id, is refused
      // by the unique index — not merely by the domain's pure validator.
      const duplicate = createProjectAgent({ projectId: project.id, agentId: agent.id }, deps);
      await expect(storage.repos.projectAgents.put(duplicate)).rejects.toThrow(/UNIQUE/i);
      expect(await storage.repos.projectAgents.listByProject(project.id)).toHaveLength(1);
    });

    it('keeps skills agent-scoped, with slugs unique per agent', async () => {
      const ux = await seedAgent('ux');
      const qa = await seedAgent('qa');
      const make = (agentId: typeof ux.id, name: string) =>
        createSkill(
          {
            agentId,
            slug: 'user-research',
            name,
            kind: SkillKind.WORKFLOW,
            source: { origin: 'content', ref: { store: 'inline', content: '#' } },
          },
          deps,
        );

      await storage.repos.skills.put(make(ux.id, 'UX flavour'));
      // Same slug, different owner: allowed.
      await storage.repos.skills.put(make(qa.id, 'QA flavour'));
      // Same slug, same owner, different id: refused.
      await expect(storage.repos.skills.put(make(ux.id, 'duplicate'))).rejects.toThrow(/UNIQUE/i);

      storage.close();
      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        expect(await reopened.repos.skills.listByAgent(ux.id)).toHaveLength(1);
        expect(await reopened.repos.skills.listByAgent(qa.id)).toHaveLength(1);
        expect((await reopened.repos.skills.findBySlug(qa.id, 'user-research'))?.name).toBe(
          'QA flavour',
        );
      } finally {
        reopened.close();
      }
    });

    it('stores agent knowledge and project knowledge in separate tables', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      await storage.repos.agentKnowledge.put(
        createAgentKnowledge(
          {
            agentId: agent.id,
            type: KnowledgeType.MARKDOWN,
            title: 'Permanent',
            source: { origin: 'human' },
            location: { store: 'inline', content: 'a' },
          },
          deps,
        ),
      );
      await storage.repos.projectKnowledge.put(
        createProjectKnowledge(
          {
            projectId: project.id,
            type: KnowledgeType.MARKDOWN,
            title: 'Temporary',
            source: { origin: 'agent', agentId: agent.id },
            location: { store: 'inline', content: 'b' },
          },
          deps,
        ),
      );
      storage.close();

      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        const agentItems = await reopened.repos.agentKnowledge.listByAgent(agent.id);
        const projectItems = await reopened.repos.projectKnowledge.listByProject(project.id);
        expect(agentItems.map((i) => i.title)).toEqual(['Permanent']);
        expect(projectItems.map((i) => i.title)).toEqual(['Temporary']);

        // Two tables, and neither has a column that could hold the other's owner.
        const agentCols = reopened.db
          .all('PRAGMA table_info(agent_knowledge)')
          .map((r) => String(r['name']));
        const projectCols = reopened.db
          .all('PRAGMA table_info(project_knowledge)')
          .map((r) => String(r['name']));
        expect(agentCols).toContain('agent_id');
        expect(agentCols).not.toContain('project_id');
        expect(projectCols).toContain('project_id');
        expect(projectCols).not.toContain('agent_id');
      } finally {
        reopened.close();
      }
    });

    it('does not touch agent knowledge when a project is deleted', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      const permanent = createAgentKnowledge(
        {
          agentId: agent.id,
          type: KnowledgeType.MARKDOWN,
          title: 'Permanent',
          source: { origin: 'human' },
          location: { store: 'inline', content: 'a' },
        },
        deps,
      );
      await storage.repos.agentKnowledge.put(permanent);
      await storage.repos.projectKnowledge.put(
        createProjectKnowledge(
          {
            projectId: project.id,
            type: KnowledgeType.MARKDOWN,
            title: 'Temporary',
            source: { origin: 'agent', agentId: agent.id },
            location: { store: 'inline', content: 'b' },
          },
          deps,
        ),
      );

      // Deleting the project cascades its own knowledge away and nothing else.
      await storage.repos.projects.delete(project.id);

      expect(await storage.repos.projectKnowledge.listByProject(project.id)).toHaveLength(0);
      expect(await storage.repos.agentKnowledge.get(permanent.id)).toEqual(permanent);
      expect(await storage.repos.agents.get(agent.id)).not.toBeNull();
    });
  });

  // ── 6. Foreign-key integrity ───────────────────────────────────

  describe('foreign keys', () => {
    it('has foreign key enforcement on', () => {
      expect(Number(storage.db.get('PRAGMA foreign_keys')?.['foreign_keys'])).toBe(1);
    });

    it('refuses a membership pointing at a project that does not exist', async () => {
      const agent = await seedAgent('ux');
      const orphan = createProject({ name: 'Never saved' }, deps);
      await expect(
        storage.repos.projectAgents.put(
          createProjectAgent({ projectId: orphan.id, agentId: agent.id }, deps),
        ),
      ).rejects.toThrow(/FOREIGN KEY/i);
    });

    it('refuses a skill pointing at an agent that does not exist', async () => {
      const ghost = createAgentDefinition({ name: 'Ghost', role: 'ghost', provider: 'x' }, deps);
      await expect(
        storage.repos.skills.put(
          createSkill(
            {
              agentId: ghost.id,
              slug: 'orphan',
              name: 'Orphan',
              kind: SkillKind.INSTRUCTION,
              source: { origin: 'content', ref: { store: 'inline', content: '#' } },
            },
            deps,
          ),
        ),
      ).rejects.toThrow(/FOREIGN KEY/i);
    });

    it('refuses a session whose project does not exist', async () => {
      const agent = await seedAgent('ux');
      const orphan = createProject({ name: 'Never saved' }, deps);
      await expect(
        storage.repos.sessions.put(
          startSession({ agentId: agent.id, projectId: orphan.id, provider: 'claude' }, deps),
        ),
      ).rejects.toThrow(/FOREIGN KEY/i);
    });

    it('cascades a deleted agent to its own skills and knowledge only', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      await storage.repos.skills.put(
        createSkill(
          {
            agentId: agent.id,
            slug: 'owned',
            name: 'Owned',
            kind: SkillKind.INSTRUCTION,
            source: { origin: 'content', ref: { store: 'inline', content: '#' } },
          },
          deps,
        ),
      );
      await storage.repos.agentKnowledge.put(
        createAgentKnowledge(
          {
            agentId: agent.id,
            type: KnowledgeType.MARKDOWN,
            title: 'Owned',
            source: { origin: 'human' },
            location: { store: 'inline', content: 'a' },
          },
          deps,
        ),
      );
      await storage.repos.projectAgents.put(
        createProjectAgent({ projectId: project.id, agentId: agent.id }, deps),
      );

      await storage.repos.agents.delete(agent.id);

      expect(await storage.repos.skills.listByAgent(agent.id)).toHaveLength(0);
      expect(await storage.repos.agentKnowledge.listByAgent(agent.id)).toHaveLength(0);
      expect(await storage.repos.projectAgents.listByProject(project.id)).toHaveLength(0);
      // The project itself is untouched.
      expect(await storage.repos.projects.get(project.id)).not.toBeNull();
    });
  });

  // ── 7, 8. Transactions, durably ────────────────────────────────

  describe('transactions', () => {
    it('commits atomically and the result survives a reopen', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');

      const taskId = await storage.uow.run(async (tx) => {
        const task = createTask(
          { projectId: project.id, title: 'Committed', assignedAgentId: agent.id },
          deps,
        );
        await tx.tasks.put(task);
        await tx.projectAgents.put(
          createProjectAgent({ projectId: project.id, agentId: agent.id }, deps),
        );
        return task.id;
      });

      storage.close();
      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        expect(await reopened.repos.tasks.get(taskId)).not.toBeNull();
        expect(await reopened.repos.projectAgents.listByProject(project.id)).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });

    it('rolls back atomically and leaves nothing behind after a reopen', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      const doomed = createTask({ projectId: project.id, title: 'Doomed' }, deps);

      await expect(
        storage.uow.run(async (tx) => {
          await tx.tasks.put(doomed);
          await tx.projectAgents.put(
            createProjectAgent({ projectId: project.id, agentId: agent.id }, deps),
          );
          await tx.projectKnowledge.put(
            createProjectKnowledge(
              {
                projectId: project.id,
                type: KnowledgeType.MARKDOWN,
                title: 'Doomed too',
                source: { origin: 'human' },
                location: { store: 'inline', content: 'x' },
              },
              deps,
            ),
          );
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      storage.close();
      const reopened = openSqliteStorage({ dataRoot: root });
      try {
        expect(await reopened.repos.tasks.get(doomed.id)).toBeNull();
        expect(await reopened.repos.projectAgents.listByProject(project.id)).toHaveLength(0);
        expect(await reopened.repos.projectKnowledge.listByProject(project.id)).toHaveLength(0);
        // Everything written before the transaction is untouched.
        expect(await reopened.repos.projects.get(project.id)).not.toBeNull();
        expect(await reopened.repos.agents.get(agent.id)).not.toBeNull();
      } finally {
        reopened.close();
      }
    });

    it('rolls back when a constraint fires mid-transaction', async () => {
      const project = await seedProject('AiWow');
      const agent = await seedAgent('ux');
      await storage.repos.projectAgents.put(
        createProjectAgent({ projectId: project.id, agentId: agent.id }, deps),
      );
      const task = createTask({ projectId: project.id, title: 'Alongside' }, deps);

      await expect(
        storage.uow.run(async (tx) => {
          await tx.tasks.put(task);
          // Violates the (project_id, agent_id) unique index.
          await tx.projectAgents.put(
            createProjectAgent({ projectId: project.id, agentId: agent.id }, deps),
          );
        }),
      ).rejects.toThrow(/UNIQUE/i);

      expect(await storage.repos.tasks.get(task.id)).toBeNull();
      expect(await storage.repos.projectAgents.listByProject(project.id)).toHaveLength(1);
    });

    it('keeps working after a rolled-back transaction', async () => {
      const project = await seedProject('AiWow');
      await expect(
        storage.uow.run(async () => {
          throw new Error('first');
        }),
      ).rejects.toThrow('first');

      const after = createTask({ projectId: project.id, title: 'After' }, deps);
      await storage.uow.run(async (tx) => {
        await tx.tasks.put(after);
      });
      expect(await storage.repos.tasks.get(after.id)).not.toBeNull();
    });
  });
});

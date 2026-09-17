/**
 * The repository contract, expressed once.
 *
 * Every storage adapter must satisfy this suite. Milestone 1 runs it against the
 * in-memory adapter; the file, SQLite and Postgres adapters in Milestone 2 run
 * the SAME suite by calling `describeRepositoryContract` with their own factory.
 * If a future adapter needs this file edited to pass, that is the signal that
 * the port has leaked an implementation detail.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentDefinition,
  Clock,
  DomainDeps,
  IdGenerator,
  Project,
  Repositories,
  Task,
  UnitOfWork,
} from '../../domain/src/index.js';
import {
  createAgentDefinition,
  createKnowledgeItem,
  createOutputItem,
  createProject,
  createSkill,
  createTask,
  KnowledgeType,
  OutputType,
  ProjectStatus,
  SessionStatus,
  SkillKind,
  startSession,
  TaskStatus,
  transitionSession,
} from '../../domain/src/index.js';

function sequentialIds(prefix: number): IdGenerator {
  let n = 0;
  return {
    next(): string {
      n += 1;
      return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${n
        .toString(16)
        .padStart(12, '0')}`;
    },
  };
}

function steppingClock(): Clock {
  let current = Date.UTC(2026, 0, 1);
  return {
    now(): string {
      const value = new Date(current).toISOString();
      current += 1000;
      return value;
    },
  };
}

/** An adapter under test: its repositories and the UnitOfWork spanning them. */
export interface ContractSubject {
  repos: Repositories;
  uow: UnitOfWork;
}

export interface ContractFactory {
  name: string;
  create(): Promise<ContractSubject> | ContractSubject;
}

export function describeRepositoryContract(factory: ContractFactory): void {
  describe(`repository contract: ${factory.name}`, () => {
    let repos: Repositories;
    let uow: UnitOfWork;
    let deps: DomainDeps;

    beforeEach(async () => {
      const subject = await factory.create();
      repos = subject.repos;
      uow = subject.uow;
      deps = { ids: sequentialIds(1), clock: steppingClock() };
    });

    async function seedProject(name: string): Promise<Project> {
      const project = createProject({ name }, deps);
      await repos.projects.put(project);
      return project;
    }

    async function seedAgent(project: Project, role: string): Promise<AgentDefinition> {
      const agent = createAgentDefinition(
        { projectId: project.id, name: `${role} Agent`, role, provider: 'claude' },
        deps,
      );
      await repos.agents.put(agent);
      return agent;
    }

    async function seedTask(
      project: Project,
      title: string,
      over: Partial<Pick<Task, 'assignedAgentId' | 'parentTaskId'>> = {},
    ): Promise<Task> {
      const task = createTask(
        {
          projectId: project.id,
          title,
          assignedAgentId: over.assignedAgentId,
          parentTaskId: over.parentTaskId,
        },
        deps,
      );
      await repos.tasks.put(task);
      return task;
    }

    // ── CRUD ───────────────────────────────────────────────────

    describe('CRUD', () => {
      it('round-trips an entity by its canonical id', async () => {
        const project = await seedProject('AiWow');
        const loaded = await repos.projects.get(project.id);

        expect(loaded).toEqual(project);
      });

      it('returns null for an id that was never stored', async () => {
        const project = createProject({ name: 'Unsaved' }, deps);
        expect(await repos.projects.get(project.id)).toBeNull();
      });

      it('upserts on put', async () => {
        const project = await seedProject('AiWow');
        await repos.projects.put({ ...project, name: 'AiWow v2' });

        expect((await repos.projects.get(project.id))?.name).toBe('AiWow v2');
        expect(await repos.projects.list()).toHaveLength(1);
      });

      it('reports whether a delete removed anything', async () => {
        const project = await seedProject('AiWow');
        expect(await repos.projects.delete(project.id)).toBe(true);
        expect(await repos.projects.delete(project.id)).toBe(false);
        expect(await repos.projects.get(project.id)).toBeNull();
      });

      it('does not hand out a live reference', async () => {
        const project = await seedProject('AiWow');
        const first = await repos.projects.get(project.id);
        first!.name = 'mutated in place';

        const second = await repos.projects.get(project.id);
        expect(second!.name).toBe('AiWow');
      });

      it('does not keep a live reference to what was put', async () => {
        const project = createProject({ name: 'AiWow' }, deps);
        await repos.projects.put(project);
        project.name = 'mutated after put';

        expect((await repos.projects.get(project.id))?.name).toBe('AiWow');
      });
    });

    // ── Project isolation ──────────────────────────────────────

    describe('project isolation', () => {
      it('never leaks agents across projects', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        const ux = await seedAgent(a, 'ux');
        await seedAgent(b, 'ui');

        const inA = await repos.agents.listByProject(a.id);
        expect(inA).toHaveLength(1);
        expect(inA[0]!.id).toBe(ux.id);
      });

      it('never leaks tasks across projects', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        await seedTask(a, 'a-task');
        await seedTask(b, 'b-task');

        expect(await repos.tasks.listByProject(a.id)).toHaveLength(1);
        expect(await repos.tasks.listByProject(b.id)).toHaveLength(1);
      });

      it('scopes findByRole to one project even when the role name repeats', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        const uxA = await seedAgent(a, 'ux');
        const uxB = await seedAgent(b, 'ux');

        expect((await repos.agents.findByRole(a.id, 'ux'))?.id).toBe(uxA.id);
        expect((await repos.agents.findByRole(b.id, 'ux'))?.id).toBe(uxB.id);
        expect(await repos.agents.findByRole(a.id, 'qa')).toBeNull();
      });

      it('never leaks knowledge or outputs across projects', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        const agentA = await seedAgent(a, 'spec');
        const taskA = await seedTask(a, 'spec it', { assignedAgentId: agentA.id });

        await repos.knowledge.put(
          createKnowledgeItem(
            {
              projectId: a.id,
              type: KnowledgeType.PRODUCT_REQUIREMENTS,
              title: 'PRD',
              source: { origin: 'human' },
              location: { store: 'inline', content: '# prd' },
            },
            deps,
          ),
        );
        await repos.outputs.put(
          createOutputItem(
            {
              projectId: a.id,
              taskId: taskA.id,
              producedByAgentId: agentA.id,
              title: 'Spec',
              type: OutputType.MARKDOWN,
              location: { store: 'inline', content: '# spec' },
            },
            deps,
          ),
        );

        expect(await repos.knowledge.listByProject(a.id)).toHaveLength(1);
        expect(await repos.knowledge.listByProject(b.id)).toHaveLength(0);
        expect(await repos.outputs.listByProject(a.id)).toHaveLength(1);
        expect(await repos.outputs.listByProject(b.id)).toHaveLength(0);
      });
    });

    // ── Filters ────────────────────────────────────────────────

    describe('filters', () => {
      it('filters projects by status', async () => {
        const active = await seedProject('Active');
        const paused = await seedProject('Paused');
        await repos.projects.put({ ...paused, status: ProjectStatus.PAUSED });

        const found = await repos.projects.list({ status: [ProjectStatus.ACTIVE] });
        expect(found.map((p) => p.id)).toEqual([active.id]);
      });

      it('filters tasks by status and by agent', async () => {
        const project = await seedProject('AiWow');
        const qa = await seedAgent(project, 'qa');
        const todo = await seedTask(project, 'todo', { assignedAgentId: qa.id });
        await repos.tasks.put({ ...todo, status: TaskStatus.TODO });
        await seedTask(project, 'unassigned');

        expect(await repos.tasks.listByAgent(qa.id)).toHaveLength(1);
        expect(
          await repos.tasks.listByProject(project.id, { status: [TaskStatus.TODO] }),
        ).toHaveLength(1);
        expect(
          await repos.tasks.listByProject(project.id, { status: [TaskStatus.DONE] }),
        ).toHaveLength(0);
      });

      it('lists children and dependencies as separate relations', async () => {
        const project = await seedProject('AiWow');
        const parent = await seedTask(project, 'parent');
        const child = await seedTask(project, 'child', { parentTaskId: parent.id });
        const blocker = await seedTask(project, 'blocker');
        await repos.tasks.put({ ...child, dependencies: [blocker.id] });

        const children = await repos.tasks.listChildren(parent.id);
        expect(children.map((t) => t.id)).toEqual([child.id]);

        const dependencies = await repos.tasks.listDependencies(child.id);
        expect(dependencies.map((t) => t.id)).toEqual([blocker.id]);

        // The two relations do not imply one another.
        expect(await repos.tasks.listChildren(blocker.id)).toHaveLength(0);
        expect(await repos.tasks.listDependencies(parent.id)).toHaveLength(0);
      });

      it('filters knowledge by type and by tag', async () => {
        const project = await seedProject('AiWow');
        await repos.knowledge.put(
          createKnowledgeItem(
            {
              projectId: project.id,
              type: KnowledgeType.UX_RESEARCH,
              title: 'Interviews',
              source: { origin: 'human' },
              location: { store: 'inline', content: 'notes' },
              tags: ['discovery', 'q1'],
            },
            deps,
          ),
        );
        await repos.knowledge.put(
          createKnowledgeItem(
            {
              projectId: project.id,
              type: KnowledgeType.DESIGN_SYSTEM,
              title: 'Tokens',
              source: { origin: 'human' },
              location: { store: 'inline', content: 'tokens' },
              tags: ['q1'],
            },
            deps,
          ),
        );

        expect(
          await repos.knowledge.listByProject(project.id, { type: [KnowledgeType.UX_RESEARCH] }),
        ).toHaveLength(1);
        expect(await repos.knowledge.listByProject(project.id, { tags: ['q1'] })).toHaveLength(2);
        expect(
          await repos.knowledge.listByProject(project.id, { tags: ['discovery'] }),
        ).toHaveLength(1);
      });

      it('offers global skills to every project alongside private ones', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        await repos.skills.put(
          createSkill(
            {
              projectId: null,
              slug: 'ux-research',
              name: 'UX Research',
              kind: SkillKind.WORKFLOW,
              source: { origin: 'content', ref: { store: 'inline', content: '#' } },
            },
            deps,
          ),
        );
        await repos.skills.put(
          createSkill(
            {
              projectId: a.id,
              slug: 'a-tone',
              name: 'A Tone',
              kind: SkillKind.INSTRUCTION,
              source: { origin: 'content', ref: { store: 'inline', content: '#' } },
            },
            deps,
          ),
        );

        expect(await repos.skills.listAvailable(a.id)).toHaveLength(2);
        expect(await repos.skills.listAvailable(b.id)).toHaveLength(1);
        expect(await repos.skills.listGlobal()).toHaveLength(1);
        expect((await repos.skills.findBySlug(null, 'ux-research'))?.slug).toBe('ux-research');
        expect(await repos.skills.findBySlug(b.id, 'a-tone')).toBeNull();
      });
    });

    // ── Sessions and external identity ─────────────────────────

    describe('sessions', () => {
      it('separates live sessions from terminal ones', async () => {
        const project = await seedProject('AiWow');
        const agent = await seedAgent(project, 'research');
        const live = startSession(
          { agentId: agent.id, projectId: project.id, provider: 'claude' },
          deps,
        );
        const ended = transitionSession(
          transitionSession(
            startSession({ agentId: agent.id, projectId: project.id, provider: 'claude' }, deps),
            SessionStatus.RUNNING,
            deps.clock,
          ),
          SessionStatus.ENDED,
          deps.clock,
        );
        await repos.sessions.put(live);
        await repos.sessions.put(ended);

        expect(await repos.sessions.listByAgent(agent.id)).toHaveLength(2);
        const liveOnly = await repos.sessions.listLiveByAgent(agent.id);
        expect(liveOnly.map((s) => s.id)).toEqual([live.id]);
      });

      it('returns a LIST for a provider session id, scoped to its provider', async () => {
        const project = await seedProject('AiWow');
        const agent = await seedAgent(project, 'research');
        const shared = 'aaaaaaaa-0000-4000-8000-000000000001';

        // The same provider id reused across two runs — legal, and the reason
        // the port returns a list rather than one session.
        const first = startSession(
          {
            agentId: agent.id,
            projectId: project.id,
            provider: 'claude',
            providerSessionId: shared,
          },
          deps,
        );
        const second = startSession(
          {
            agentId: agent.id,
            projectId: project.id,
            provider: 'claude',
            providerSessionId: shared,
          },
          deps,
        );
        // A different provider that happens to mint the same id.
        const other = startSession(
          {
            agentId: agent.id,
            projectId: project.id,
            provider: 'codex',
            providerSessionId: shared,
          },
          deps,
        );
        await repos.sessions.put(first);
        await repos.sessions.put(second);
        await repos.sessions.put(other);

        const claude = await repos.sessions.listByProviderSessionId('claude', shared);
        expect(claude).toHaveLength(2);
        expect(await repos.sessions.listByProviderSessionId('codex', shared)).toHaveLength(1);
        expect(await repos.sessions.listByProviderSessionId('claude', 'nope')).toHaveLength(0);
      });

      it('stores a session that has no provider id at all', async () => {
        const project = await seedProject('AiWow');
        const agent = await seedAgent(project, 'research');
        const session = startSession(
          { agentId: agent.id, projectId: project.id, provider: 'claude' },
          deps,
        );
        await repos.sessions.put(session);

        expect((await repos.sessions.get(session.id))?.providerSessionId).toBeUndefined();
        expect(await repos.sessions.listByProject(project.id)).toHaveLength(1);
      });

      it('keeps the agent definition after its session is deleted', async () => {
        const project = await seedProject('AiWow');
        const agent = await seedAgent(project, 'research');
        const session = startSession(
          { agentId: agent.id, projectId: project.id, provider: 'claude' },
          deps,
        );
        await repos.sessions.put(session);

        await repos.sessions.delete(session.id);

        expect(await repos.sessions.get(session.id)).toBeNull();
        expect(await repos.agents.get(agent.id)).not.toBeNull();
      });
    });

    // ── Blobs ──────────────────────────────────────────────────

    describe('blob store', () => {
      it('round-trips content through an opaque reference', async () => {
        const project = await seedProject('AiWow');
        const ref = await repos.blobs.write({ projectId: project.id, name: 'prd.md' }, '# PRD');

        expect(await repos.blobs.read(ref)).toBe('# PRD');
        expect(await repos.blobs.delete(ref)).toBe(true);
      });

      it('reads an inline reference without having stored it', async () => {
        expect(await repos.blobs.read({ store: 'inline', content: 'hello' })).toBe('hello');
      });

      it('keeps two projects from colliding on the same name', async () => {
        const a = await seedProject('A');
        const b = await seedProject('B');
        const refA = await repos.blobs.write({ projectId: a.id, name: 'notes.md' }, 'from A');
        const refB = await repos.blobs.write({ projectId: b.id, name: 'notes.md' }, 'from B');

        expect(await repos.blobs.read(refA)).toBe('from A');
        expect(await repos.blobs.read(refB)).toBe('from B');
      });
    });

    // ── Transactions ───────────────────────────────────────────
    //
    // All-or-nothing, identical for every adapter. An adapter that cannot roll
    // back does not satisfy this port. The tests assert BEHAVIOUR only — no
    // snapshot, handle, connection or transaction type is referenced — so an
    // in-memory adapter and a SQL one are held to the same standard.

    describe('transactions', () => {
      /** Marker error, so a rollback assertion cannot pass on an unrelated throw. */
      class Boom extends Error {
        constructor() {
          super('boom');
          this.name = 'Boom';
        }
      }

      it('1. commits every write when the transaction succeeds', async () => {
        const project = await seedProject('AiWow');

        const returned = await uow.run(async (tx) => {
          const agent = createAgentDefinition(
            { projectId: project.id, name: 'UX Agent', role: 'ux', provider: 'claude' },
            deps,
          );
          await tx.agents.put(agent);
          const task = createTask(
            { projectId: project.id, title: 'Map the flow', assignedAgentId: agent.id },
            deps,
          );
          await tx.tasks.put(task);
          await tx.projects.put({ ...project, name: 'AiWow v2' });
          return { agentId: agent.id, taskId: task.id };
        });

        // Committed state is visible outside the transaction.
        expect(await repos.agents.get(returned.agentId)).not.toBeNull();
        expect(await repos.tasks.get(returned.taskId)).not.toBeNull();
        expect((await repos.projects.get(project.id))?.name).toBe('AiWow v2');
      });

      it('2. rolls back every write when the transaction fails', async () => {
        const project = await seedProject('AiWow');
        const agent = createAgentDefinition(
          { projectId: project.id, name: 'UX Agent', role: 'ux', provider: 'claude' },
          deps,
        );
        const task = createTask({ projectId: project.id, title: 'Doomed' }, deps);

        await expect(
          uow.run(async (tx) => {
            await tx.agents.put(agent);
            await tx.tasks.put(task);
            await tx.knowledge.put(
              createKnowledgeItem(
                {
                  projectId: project.id,
                  type: KnowledgeType.MARKDOWN,
                  title: 'Notes',
                  source: { origin: 'human' },
                  location: { store: 'inline', content: 'x' },
                },
                deps,
              ),
            );
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        expect(await repos.agents.get(agent.id)).toBeNull();
        expect(await repos.tasks.get(task.id)).toBeNull();
        expect(await repos.agents.listByProject(project.id)).toHaveLength(0);
        expect(await repos.tasks.listByProject(project.id)).toHaveLength(0);
        expect(await repos.knowledge.listByProject(project.id)).toHaveLength(0);
        // The pre-transaction write is untouched.
        expect(await repos.projects.get(project.id)).not.toBeNull();
      });

      it('3. restores updates when the transaction fails', async () => {
        const project = await seedProject('AiWow');
        const agent = await seedAgent(project, 'ux');
        const task = await seedTask(project, 'Original title', { assignedAgentId: agent.id });

        await expect(
          uow.run(async (tx) => {
            await tx.projects.put({ ...project, name: 'Renamed', status: ProjectStatus.ARCHIVED });
            await tx.agents.put({ ...agent, name: 'Renamed Agent' });
            await tx.tasks.put({ ...task, title: 'Renamed title', status: TaskStatus.DONE });
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        const rolledBackProject = await repos.projects.get(project.id);
        expect(rolledBackProject?.name).toBe('AiWow');
        expect(rolledBackProject?.status).toBe(ProjectStatus.ACTIVE);
        expect((await repos.agents.get(agent.id))?.name).toBe(agent.name);
        const rolledBackTask = await repos.tasks.get(task.id);
        expect(rolledBackTask?.title).toBe('Original title');
        expect(rolledBackTask?.status).toBe(TaskStatus.BACKLOG);
      });

      it('4. restores deletes when the transaction fails', async () => {
        const project = await seedProject('AiWow');
        const agent = await seedAgent(project, 'ux');
        const task = await seedTask(project, 'Kept', { assignedAgentId: agent.id });

        await expect(
          uow.run(async (tx) => {
            expect(await tx.agents.delete(agent.id)).toBe(true);
            expect(await tx.tasks.delete(task.id)).toBe(true);
            // Gone as far as the transaction is concerned...
            expect(await tx.agents.get(agent.id)).toBeNull();
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        // ...and back afterwards, byte for byte.
        expect(await repos.agents.get(agent.id)).toEqual(agent);
        expect(await repos.tasks.get(task.id)).toEqual(task);
        expect(await repos.agents.listByProject(project.id)).toHaveLength(1);
        expect(await repos.tasks.listByProject(project.id)).toHaveLength(1);
      });

      it('5. rolls back atomically across several repository types', async () => {
        // Project update + Task create + Agent delete. One of them throws, so
        // all three must be back where they started.
        const project = await seedProject('AiWow');
        const doomedAgent = await seedAgent(project, 'qa');
        const newTask = createTask({ projectId: project.id, title: 'Never created' }, deps);

        await expect(
          uow.run(async (tx) => {
            await tx.projects.put({ ...project, description: 'edited' });
            await tx.tasks.put(newTask);
            await tx.agents.delete(doomedAgent.id);
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        expect((await repos.projects.get(project.id))?.description).toBe('');
        expect(await repos.tasks.get(newTask.id)).toBeNull();
        expect(await repos.agents.get(doomedAgent.id)).toEqual(doomedAgent);
      });

      it('rolls back blob writes too', async () => {
        const project = await seedProject('AiWow');
        let ref: Awaited<ReturnType<typeof repos.blobs.write>> | undefined;

        await expect(
          uow.run(async (tx) => {
            ref = await tx.blobs.write({ projectId: project.id, name: 'prd.md' }, '# PRD');
            expect(await tx.blobs.read(ref)).toBe('# PRD');
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        expect(ref).toBeDefined();
        await expect(repos.blobs.read(ref!)).rejects.toThrow();
      });

      it('rethrows the original error unchanged', async () => {
        const boom = new Boom();
        await expect(uow.run(async () => Promise.reject(boom))).rejects.toBe(boom);
      });

      it('leaves earlier committed transactions alone when a later one fails', async () => {
        const project = await seedProject('AiWow');
        const kept = createTask({ projectId: project.id, title: 'Committed' }, deps);
        await uow.run(async (tx) => {
          await tx.tasks.put(kept);
        });

        await expect(
          uow.run(async (tx) => {
            await tx.tasks.put(createTask({ projectId: project.id, title: 'Discarded' }, deps));
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        const remaining = await repos.tasks.listByProject(project.id);
        expect(remaining.map((t) => t.title)).toEqual(['Committed']);
      });

      it('keeps working after a rolled-back transaction', async () => {
        const project = await seedProject('AiWow');
        await expect(
          uow.run(async () => {
            throw new Boom();
          }),
        ).rejects.toThrow(Boom);

        const after = createTask({ projectId: project.id, title: 'After the failure' }, deps);
        await uow.run(async (tx) => {
          await tx.tasks.put(after);
        });
        expect(await repos.tasks.get(after.id)).not.toBeNull();
      });
    });

    // ── Async contract ─────────────────────────────────────────

    it('returns promises from every port method', async () => {
      const project = await seedProject('AiWow');
      const calls = [
        repos.projects.get(project.id),
        repos.projects.list(),
        repos.agents.listByProject(project.id),
        repos.tasks.listByProject(project.id),
        repos.sessions.listByProject(project.id),
        repos.skills.listAvailable(project.id),
        repos.knowledge.listByProject(project.id),
        repos.outputs.listByProject(project.id),
      ];
      for (const call of calls) {
        expect(call).toBeInstanceOf(Promise);
      }
      await Promise.all(calls);
    });
  });
}

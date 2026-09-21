/**
 * In-memory implementations of every domain storage port.
 *
 * These are the Milestone 1 adapters: enough to exercise the domain and to run
 * the repository contract suite, with no filesystem and no database. The file /
 * SQLite / Postgres adapters arrive in Milestone 2 and must pass the same
 * contract tests unchanged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  AgentDefinition,
  AgentId,
  AgentKnowledge,
  AgentKnowledgeId,
  AgentKnowledgeRepository,
  AgentRepository,
  AgentSession,
  AgentSessionRepository,
  BlobOwner,
  BlobStore,
  KnowledgeFilter,
  OutputId,
  OutputItem,
  OutputRepository,
  Project,
  ProjectAgent,
  ProjectAgentId,
  ProjectAgentRepository,
  ProjectId,
  ProjectKnowledge,
  ProjectKnowledgeId,
  ProjectKnowledgeRepository,
  ProjectRepository,
  ProjectStatus,
  Repositories,
  ResourceRef,
  SessionId,
  Skill,
  SkillId,
  SkillRepository,
  Task,
  TaskId,
  TaskRepository,
  TaskStatus,
  UnitOfWork,
} from '../../../domain/src/index.js';
import { isLiveSession } from '../../../domain/src/index.js';
import { InMemoryRepository } from './inMemoryRepository.js';
import type { SnapshotHandle, Snapshottable } from './transaction.js';
import { captureAll, captureMap, Mutex } from './transaction.js';

export class InMemoryProjectRepository
  extends InMemoryRepository<Project, ProjectId>
  implements ProjectRepository
{
  async list(filter?: { status?: readonly ProjectStatus[] }): Promise<Project[]> {
    const wanted = filter?.status;
    return this.all().filter((project) => !wanted || wanted.includes(project.status));
  }
}

export class InMemoryAgentRepository
  extends InMemoryRepository<AgentDefinition, AgentId>
  implements AgentRepository
{
  async list(): Promise<AgentDefinition[]> {
    return this.all();
  }

  async listByRole(role: string): Promise<AgentDefinition[]> {
    return this.all().filter((agent) => agent.role === role);
  }
}

export class InMemoryProjectAgentRepository
  extends InMemoryRepository<ProjectAgent, ProjectAgentId>
  implements ProjectAgentRepository
{
  async listByProject(projectId: ProjectId): Promise<ProjectAgent[]> {
    return this.all().filter((m) => m.projectId === projectId);
  }

  async listByAgent(agentId: AgentId): Promise<ProjectAgent[]> {
    return this.all().filter((m) => m.agentId === agentId);
  }

  async find(projectId: ProjectId, agentId: AgentId): Promise<ProjectAgent | null> {
    return this.all().find((m) => m.projectId === projectId && m.agentId === agentId) ?? null;
  }

  async listReports(projectId: ProjectId, managerAgentId: AgentId): Promise<ProjectAgent[]> {
    return this.all().filter(
      (m) => m.projectId === projectId && m.managerAgentId === managerAgentId,
    );
  }
}

export class InMemoryAgentSessionRepository
  extends InMemoryRepository<AgentSession, SessionId>
  implements AgentSessionRepository
{
  async listByProject(projectId: ProjectId): Promise<AgentSession[]> {
    return this.all().filter((session) => session.projectId === projectId);
  }

  async listByAgent(agentId: AgentId): Promise<AgentSession[]> {
    return this.all().filter((session) => session.agentId === agentId);
  }

  async listLiveByAgent(agentId: AgentId): Promise<AgentSession[]> {
    return this.all().filter(
      (session) => session.agentId === agentId && isLiveSession(session.status),
    );
  }

  async listByProviderSessionId(
    provider: string,
    providerSessionId: string,
  ): Promise<AgentSession[]> {
    // Scoped by provider: two providers may legitimately mint the same id, and
    // one provider may reuse an id across runs. Hence a list, never a lookup.
    return this.all().filter(
      (session) => session.provider === provider && session.providerSessionId === providerSessionId,
    );
  }
}

export class InMemoryTaskRepository
  extends InMemoryRepository<Task, TaskId>
  implements TaskRepository
{
  async listByProject(
    projectId: ProjectId,
    filter?: { status?: readonly TaskStatus[] },
  ): Promise<Task[]> {
    const wanted = filter?.status;
    return this.all().filter(
      (task) => task.projectId === projectId && (!wanted || wanted.includes(task.status)),
    );
  }

  async listByAgent(
    agentId: AgentId,
    filter?: { status?: readonly TaskStatus[] },
  ): Promise<Task[]> {
    const wanted = filter?.status;
    return this.all().filter(
      (task) => task.assignedAgentId === agentId && (!wanted || wanted.includes(task.status)),
    );
  }

  async listChildren(parentTaskId: TaskId): Promise<Task[]> {
    return this.all().filter((task) => task.parentTaskId === parentTaskId);
  }

  async listDependencies(taskId: TaskId): Promise<Task[]> {
    const task = this.items.get(taskId);
    if (!task) {
      return [];
    }
    const resolved: Task[] = [];
    for (const dependencyId of task.dependencies) {
      const dependency = await this.get(dependencyId);
      if (dependency) {
        resolved.push(dependency);
      }
    }
    return resolved;
  }
}

export class InMemorySkillRepository
  extends InMemoryRepository<Skill, SkillId>
  implements SkillRepository
{
  async listByAgent(agentId: AgentId): Promise<Skill[]> {
    return this.all().filter((skill) => skill.agentId === agentId);
  }

  async findBySlug(agentId: AgentId, slug: string): Promise<Skill | null> {
    const found = this.all().find((skill) => skill.agentId === agentId && skill.slug === slug);
    return found ?? null;
  }
}

/** Shared filter predicate for both knowledge kinds. */
function matchesKnowledgeFilter(
  item: { type: AgentKnowledge['type']; tags: readonly string[] },
  filter?: KnowledgeFilter,
): boolean {
  if (filter?.type && !filter.type.includes(item.type)) {
    return false;
  }
  if (filter?.tags && !filter.tags.every((tag) => item.tags.includes(tag))) {
    return false;
  }
  return true;
}

export class InMemoryAgentKnowledgeRepository
  extends InMemoryRepository<AgentKnowledge, AgentKnowledgeId>
  implements AgentKnowledgeRepository
{
  async listByAgent(agentId: AgentId, filter?: KnowledgeFilter): Promise<AgentKnowledge[]> {
    return this.all().filter(
      (item) => item.agentId === agentId && matchesKnowledgeFilter(item, filter),
    );
  }
}

export class InMemoryProjectKnowledgeRepository
  extends InMemoryRepository<ProjectKnowledge, ProjectKnowledgeId>
  implements ProjectKnowledgeRepository
{
  async listByProject(projectId: ProjectId, filter?: KnowledgeFilter): Promise<ProjectKnowledge[]> {
    return this.all().filter(
      (item) => item.projectId === projectId && matchesKnowledgeFilter(item, filter),
    );
  }
}

export class InMemoryOutputRepository
  extends InMemoryRepository<OutputItem, OutputId>
  implements OutputRepository
{
  async listByProject(projectId: ProjectId): Promise<OutputItem[]> {
    return this.all().filter((output) => output.projectId === projectId);
  }

  async listByTask(taskId: TaskId): Promise<OutputItem[]> {
    return this.all().filter((output) => output.taskId === taskId);
  }
}

/**
 * In-memory blob store. Keys are namespaced by owner (project or agent) so a
 * listing is possible later, two owners cannot collide on a name, and the
 * ownership boundary holds for content as well as metadata.
 */
export class InMemoryBlobStore implements BlobStore, Snapshottable {
  private readonly blobs = new Map<string, string>();
  private counter = 0;

  /** Transaction support. The counter is part of the state: rolling back a
   *  transaction that wrote blobs must also give back the key sequence, or a
   *  retry produces different keys for the same content. */
  capture(): SnapshotHandle {
    const blobs = captureMap(this.blobs);
    const counter = this.counter;
    return {
      restore: (): void => {
        blobs.restore();
        this.counter = counter;
      },
    };
  }

  async read(ref: ResourceRef): Promise<string> {
    if (ref.store === 'inline') {
      return ref.content;
    }
    if (ref.store !== 'blob') {
      throw new Error(`InMemoryBlobStore cannot read a '${ref.store}' reference`);
    }
    const found = this.blobs.get(ref.key);
    if (found === undefined) {
      throw new Error(`blob not found: ${ref.key}`);
    }
    return found;
  }

  async write(hint: { owner: BlobOwner; name: string }, content: string): Promise<ResourceRef> {
    this.counter += 1;
    // Owner kind is part of the key, so agent-owned content can never collide
    // with (or be mistaken for) project-owned content.
    const scope =
      hint.owner.kind === 'project'
        ? `project/${hint.owner.projectId}`
        : `agent/${hint.owner.agentId}`;
    const key = `${scope}/${this.counter}-${hint.name}`;
    this.blobs.set(key, content);
    return { store: 'blob', key };
  }

  async delete(ref: ResourceRef): Promise<boolean> {
    return ref.store === 'blob' ? this.blobs.delete(ref.key) : false;
  }

  clear(): void {
    this.blobs.clear();
    this.counter = 0;
  }
}

export interface InMemoryRepositories extends Repositories {
  projects: InMemoryProjectRepository;
  agents: InMemoryAgentRepository;
  projectAgents: InMemoryProjectAgentRepository;
  sessions: InMemoryAgentSessionRepository;
  tasks: InMemoryTaskRepository;
  skills: InMemorySkillRepository;
  agentKnowledge: InMemoryAgentKnowledgeRepository;
  projectKnowledge: InMemoryProjectKnowledgeRepository;
  outputs: InMemoryOutputRepository;
  blobs: InMemoryBlobStore;
}

export function createInMemoryRepositories(): InMemoryRepositories {
  return {
    projects: new InMemoryProjectRepository(),
    agents: new InMemoryAgentRepository(),
    projectAgents: new InMemoryProjectAgentRepository(),
    sessions: new InMemoryAgentSessionRepository(),
    tasks: new InMemoryTaskRepository(),
    skills: new InMemorySkillRepository(),
    agentKnowledge: new InMemoryAgentKnowledgeRepository(),
    projectKnowledge: new InMemoryProjectKnowledgeRepository(),
    outputs: new InMemoryOutputRepository(),
    blobs: new InMemoryBlobStore(),
  };
}

/**
 * Transactional UnitOfWork: all-or-nothing, matching what a SQL adapter gives.
 *
 * snapshot → execute → success: discard the snapshot
 *                    → failure: restore the snapshot, then rethrow
 *
 * Every repository and the blob store are captured together, so a failure part
 * way through a multi-repository write leaves none of it behind. The whole
 * mechanism (snapshots, handles, the mutex) is storage-internal; the domain's
 * `UnitOfWork` port is still one `run()` method and knows nothing about it.
 *
 * Top-level transactions are serialised. Two overlapping ones would each
 * snapshot a state already containing the other's writes, so one rollback would
 * discard the other's committed work.
 *
 * A `run()` nested inside another JOINS the outer transaction rather than
 * opening its own: it takes no snapshot and commits nothing, so a throw
 * anywhere inside rolls the whole outer transaction back. Opening a second one
 * would deadlock on the mutex, and treating it as independent would let an
 * inner commit survive an outer rollback.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private readonly mutex = new Mutex();
  private readonly targets: readonly Snapshottable[];
  /**
   * Marks the async context of a transaction in flight.
   *
   * A plain depth counter cannot do this job: while an outer transaction is
   * parked on an `await`, an UNRELATED top-level caller would also observe
   * depth > 0, silently join a transaction it knows nothing about, and be
   * rolled back with it — after its own callback had already returned
   * successfully. AsyncLocalStorage answers the question actually being asked,
   * "am I running inside that callback", rather than "is one open somewhere".
   */
  private readonly inTransaction = new AsyncLocalStorage<true>();

  constructor(private readonly repos: InMemoryRepositories) {
    this.targets = [
      repos.projects,
      repos.agents,
      repos.projectAgents,
      repos.sessions,
      repos.tasks,
      repos.skills,
      repos.agentKnowledge,
      repos.projectKnowledge,
      repos.outputs,
      repos.blobs,
    ];
  }

  async run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.inTransaction.getStore()) {
      return fn(this.repos);
    }
    return this.mutex.run(() =>
      this.inTransaction.run(true, async () => {
        const snapshot: SnapshotHandle = captureAll(this.targets);
        try {
          return await fn(this.repos);
        } catch (error) {
          snapshot.restore();
          throw error;
        }
      }),
    );
  }
}

/** Repositories plus the UnitOfWork that spans them. */
export interface InMemoryStorage {
  repos: InMemoryRepositories;
  uow: InMemoryUnitOfWork;
}

export function createInMemoryStorage(): InMemoryStorage {
  const repos = createInMemoryRepositories();
  return { repos, uow: new InMemoryUnitOfWork(repos) };
}

/**
 * In-memory implementations of every domain storage port.
 *
 * These are the Milestone 1 adapters: enough to exercise the domain and to run
 * the repository contract suite, with no filesystem and no database. The file /
 * SQLite / Postgres adapters arrive in Milestone 2 and must pass the same
 * contract tests unchanged.
 */

import type {
  AgentDefinition,
  AgentId,
  AgentRepository,
  AgentSession,
  AgentSessionRepository,
  BlobStore,
  KnowledgeId,
  KnowledgeItem,
  KnowledgeRepository,
  KnowledgeType,
  OutputId,
  OutputItem,
  OutputRepository,
  Project,
  ProjectId,
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
  async listByProject(projectId: ProjectId): Promise<AgentDefinition[]> {
    return this.all().filter((agent) => agent.projectId === projectId);
  }

  async findByRole(projectId: ProjectId, role: string): Promise<AgentDefinition | null> {
    const found = this.all().find((agent) => agent.projectId === projectId && agent.role === role);
    return found ?? null;
  }

  async listReports(managerAgentId: AgentId): Promise<AgentDefinition[]> {
    return this.all().filter((agent) => agent.managerAgentId === managerAgentId);
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
  async listAvailable(projectId: ProjectId): Promise<Skill[]> {
    return this.all().filter((skill) => skill.projectId === null || skill.projectId === projectId);
  }

  async listGlobal(): Promise<Skill[]> {
    return this.all().filter((skill) => skill.projectId === null);
  }

  async findBySlug(projectId: ProjectId | null, slug: string): Promise<Skill | null> {
    const found = this.all().find((skill) => skill.projectId === projectId && skill.slug === slug);
    return found ?? null;
  }
}

export class InMemoryKnowledgeRepository
  extends InMemoryRepository<KnowledgeItem, KnowledgeId>
  implements KnowledgeRepository
{
  async listByProject(
    projectId: ProjectId,
    filter?: { type?: readonly KnowledgeType[]; tags?: readonly string[] },
  ): Promise<KnowledgeItem[]> {
    const types = filter?.type;
    const tags = filter?.tags;
    return this.all().filter((item) => {
      if (item.projectId !== projectId) {
        return false;
      }
      if (types && !types.includes(item.type)) {
        return false;
      }
      if (tags && !tags.every((tag) => item.tags.includes(tag))) {
        return false;
      }
      return true;
    });
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
 * In-memory blob store. Keys are namespaced per project so a listing is possible
 * later and so two projects cannot collide on a name.
 */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, string>();
  private counter = 0;

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

  async write(hint: { projectId: ProjectId; name: string }, content: string): Promise<ResourceRef> {
    this.counter += 1;
    const key = `${hint.projectId}/${this.counter}-${hint.name}`;
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
  sessions: InMemoryAgentSessionRepository;
  tasks: InMemoryTaskRepository;
  skills: InMemorySkillRepository;
  knowledge: InMemoryKnowledgeRepository;
  outputs: InMemoryOutputRepository;
  blobs: InMemoryBlobStore;
}

export function createInMemoryRepositories(): InMemoryRepositories {
  return {
    projects: new InMemoryProjectRepository(),
    agents: new InMemoryAgentRepository(),
    sessions: new InMemoryAgentSessionRepository(),
    tasks: new InMemoryTaskRepository(),
    skills: new InMemorySkillRepository(),
    knowledge: new InMemoryKnowledgeRepository(),
    outputs: new InMemoryOutputRepository(),
    blobs: new InMemoryBlobStore(),
  };
}

/**
 * Non-transactional UnitOfWork.
 *
 * It runs the callback and propagates failures; it does NOT roll back, because
 * a Map has nothing to roll back to. That is an honest limitation of an
 * in-memory adapter rather than a stub — the port exists so the SQL adapter can
 * wrap a real transaction later without any call site changing.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly repos: InMemoryRepositories) {}

  async run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return fn(this.repos);
  }
}

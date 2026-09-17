/**
 * Storage ports.
 *
 * Interfaces only. The domain never imports a filesystem, a database driver, or
 * the server — a domain that knows where it is stored is not storage-independent
 * (ADR 004). `storage/` supplies the adapters; `~/.agent-office/` is a decision
 * that belongs to one of them, not to this file.
 *
 * Every method returns a Promise even where an implementation is synchronous.
 * An in-memory repository could be synchronous today, but committing to that in
 * the port would make every call site change the day it becomes SQL.
 */

import type { AgentDefinition } from './agentDefinition.js';
import type { AgentSession } from './agentSession.js';
import type {
  AgentId,
  KnowledgeId,
  OutputId,
  ProjectId,
  SessionId,
  SkillId,
  TaskId,
} from './ids.js';
import type { KnowledgeItem, KnowledgeType } from './knowledge.js';
import type { OutputItem } from './output.js';
import type { Project, ProjectStatus } from './project.js';
import type { ResourceRef } from './resource.js';
import type { Skill } from './skill.js';
import type { Task, TaskStatus } from './task.js';

/** Common CRUD shape. `put` is an upsert keyed on the entity's canonical id. */
export interface Repository<T, Id> {
  get(id: Id): Promise<T | null>;
  put(entity: T): Promise<void>;
  delete(id: Id): Promise<boolean>;
}

export interface ProjectRepository extends Repository<Project, ProjectId> {
  list(filter?: { status?: readonly ProjectStatus[] }): Promise<Project[]>;
}

export interface AgentRepository extends Repository<AgentDefinition, AgentId> {
  listByProject(projectId: ProjectId): Promise<AgentDefinition[]>;
  /** Roles are unique per project, so this returns at most one. */
  findByRole(projectId: ProjectId, role: string): Promise<AgentDefinition | null>;
  listReports(managerAgentId: AgentId): Promise<AgentDefinition[]>;
}

export interface AgentSessionRepository extends Repository<AgentSession, SessionId> {
  listByProject(projectId: ProjectId): Promise<AgentSession[]>;
  listByAgent(agentId: AgentId): Promise<AgentSession[]>;
  /** Live sessions (starting / running / idle) for an agent. */
  listLiveByAgent(agentId: AgentId): Promise<AgentSession[]>;
  /**
   * Returns a LIST, not one session. A provider id may be absent, may be reused
   * across runs, and is scoped to its provider — so this can legitimately match
   * zero, one, or several sessions, and the caller decides which it meant.
   */
  listByProviderSessionId(provider: string, providerSessionId: string): Promise<AgentSession[]>;
}

export interface TaskRepository extends Repository<Task, TaskId> {
  listByProject(projectId: ProjectId, filter?: { status?: readonly TaskStatus[] }): Promise<Task[]>;
  listByAgent(agentId: AgentId, filter?: { status?: readonly TaskStatus[] }): Promise<Task[]>;
  /** Direct children in the decomposition tree. */
  listChildren(parentTaskId: TaskId): Promise<Task[]>;
  /** Tasks the given task depends on. */
  listDependencies(taskId: TaskId): Promise<Task[]>;
}

export interface SkillRepository extends Repository<Skill, SkillId> {
  /** Global skills plus the project's own. */
  listAvailable(projectId: ProjectId): Promise<Skill[]>;
  listGlobal(): Promise<Skill[]>;
  findBySlug(projectId: ProjectId | null, slug: string): Promise<Skill | null>;
}

export interface KnowledgeRepository extends Repository<KnowledgeItem, KnowledgeId> {
  listByProject(
    projectId: ProjectId,
    filter?: { type?: readonly KnowledgeType[]; tags?: readonly string[] },
  ): Promise<KnowledgeItem[]>;
}

export interface OutputRepository extends Repository<OutputItem, OutputId> {
  listByProject(projectId: ProjectId): Promise<OutputItem[]>;
  listByTask(taskId: TaskId): Promise<OutputItem[]>;
}

/**
 * Content storage, separate from metadata storage. Knowledge and Output records
 * are small and queryable; their content may be megabytes and is not.
 */
export interface BlobStore {
  read(ref: ResourceRef): Promise<string>;
  write(hint: { projectId: ProjectId; name: string }, content: string): Promise<ResourceRef>;
  delete(ref: ResourceRef): Promise<boolean>;
}

export interface Repositories {
  projects: ProjectRepository;
  agents: AgentRepository;
  sessions: AgentSessionRepository;
  tasks: TaskRepository;
  skills: SkillRepository;
  knowledge: KnowledgeRepository;
  outputs: OutputRepository;
  blobs: BlobStore;
}

/**
 * Atomicity boundary for writes spanning more than one repository — creating a
 * Task, assigning an Agent and recording an Output in one step, say.
 *
 * The contract is all-or-nothing and is the SAME for every adapter:
 *
 *  - the callback returns  → every write inside it is committed;
 *  - the callback throws   → every write inside it is rolled back, across all
 *                            repositories, and the error is rethrown unchanged.
 *
 * Rollback is not optional for adapters that find it inconvenient. An in-memory
 * adapter snapshots and restores; a SQL adapter opens a real transaction. A
 * caller must be able to reason about failure identically either way, so
 * `storage/__tests__/repositoryContract.ts` pins the behaviour rather than the
 * mechanism.
 *
 * How a given adapter achieves it is entirely its own business — no snapshot,
 * handle, connection or transaction type appears in this port.
 */
export interface UnitOfWork {
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

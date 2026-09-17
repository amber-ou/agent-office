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
  AgentKnowledgeId,
  OutputId,
  ProjectAgentId,
  ProjectId,
  ProjectKnowledgeId,
  SessionId,
  SkillId,
  TaskId,
} from './ids.js';
import type { AgentKnowledge, KnowledgeType, ProjectKnowledge } from './knowledge.js';
import type { OutputItem } from './output.js';
import type { Project, ProjectStatus } from './project.js';
import type { ProjectAgent } from './projectAgent.js';
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

/**
 * Agents are global — there is no `listByProject` here. Which agents work on a
 * project is a membership question, answered by ProjectAgentRepository.
 */
export interface AgentRepository extends Repository<AgentDefinition, AgentId> {
  list(): Promise<AgentDefinition[]>;
  /** Returns a LIST: Agent Office does not enforce role uniqueness, so two
   *  differently-configured agents may legitimately share a role. */
  listByRole(role: string): Promise<AgentDefinition[]>;
}

/** The Project <-> Agent many-to-many relation. */
export interface ProjectAgentRepository extends Repository<ProjectAgent, ProjectAgentId> {
  listByProject(projectId: ProjectId): Promise<ProjectAgent[]>;
  listByAgent(agentId: AgentId): Promise<ProjectAgent[]>;
  /** The membership for one pair, or null. Uniqueness is (projectId, agentId). */
  find(projectId: ProjectId, agentId: AgentId): Promise<ProjectAgent | null>;
  /** Direct reports within one project. */
  listReports(projectId: ProjectId, managerAgentId: AgentId): Promise<ProjectAgent[]>;
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

/**
 * Skills belong to one agent. There is no global library, so no `listGlobal`
 * and no cross-agent lookup.
 */
export interface SkillRepository extends Repository<Skill, SkillId> {
  listByAgent(agentId: AgentId): Promise<Skill[]>;
  /** Slugs are unique within their owning agent. */
  findBySlug(agentId: AgentId, slug: string): Promise<Skill | null>;
}

/** Filter shared by both knowledge repositories. */
export interface KnowledgeFilter {
  type?: readonly KnowledgeType[];
  tags?: readonly string[];
}

/**
 * Two knowledge repositories, not one with an owner filter.
 *
 * Separate ports are what make "project work never becomes agent knowledge"
 * structural: there is no call that writes a ProjectKnowledge through the agent
 * repository, because the types do not match (ADR 005).
 */
export interface AgentKnowledgeRepository extends Repository<AgentKnowledge, AgentKnowledgeId> {
  listByAgent(agentId: AgentId, filter?: KnowledgeFilter): Promise<AgentKnowledge[]>;
}

export interface ProjectKnowledgeRepository extends Repository<
  ProjectKnowledge,
  ProjectKnowledgeId
> {
  listByProject(projectId: ProjectId, filter?: KnowledgeFilter): Promise<ProjectKnowledge[]>;
}

export interface OutputRepository extends Repository<OutputItem, OutputId> {
  listByProject(projectId: ProjectId): Promise<OutputItem[]>;
  listByTask(taskId: TaskId): Promise<OutputItem[]>;
}

/**
 * Who a blob belongs to. Carried into the key so agent-owned content is never
 * namespaced under a project, and project content is never namespaced under an
 * agent — the ownership boundary holds for the bytes as well as the metadata.
 */
export type BlobOwner =
  { kind: 'project'; projectId: ProjectId } | { kind: 'agent'; agentId: AgentId };

/**
 * Content storage, separate from metadata storage. Knowledge and Output records
 * are small and queryable; their content may be megabytes and is not.
 */
export interface BlobStore {
  read(ref: ResourceRef): Promise<string>;
  write(hint: { owner: BlobOwner; name: string }, content: string): Promise<ResourceRef>;
  delete(ref: ResourceRef): Promise<boolean>;
}

export interface Repositories {
  projects: ProjectRepository;
  agents: AgentRepository;
  projectAgents: ProjectAgentRepository;
  sessions: AgentSessionRepository;
  tasks: TaskRepository;
  skills: SkillRepository;
  agentKnowledge: AgentKnowledgeRepository;
  projectKnowledge: ProjectKnowledgeRepository;
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

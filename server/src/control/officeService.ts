/**
 * Application services for the Agent Office control plane.
 *
 * This is the layer between the transport and the repositories. It composes
 * domain factories with repository calls and enforces the cross-entity rules
 * the domain expresses as pure assertions but cannot check on its own (a
 * membership needs to know the project's other memberships; the domain does no
 * I/O, so the service fetches them and hands them over).
 *
 * The office UI never reaches past this layer, and this layer never reaches
 * past the repository ports.
 */

import type {
  AgentDefinition,
  AgentId,
  DomainDeps,
  Project,
  ProjectAgent,
  ProjectId,
  Repositories,
  Task,
  TaskId,
} from '../../../domain/src/index.js';
import {
  asAgentId,
  asProjectId,
  assertNotAlreadyMember,
  createAgentDefinition,
  createProject,
  createProjectAgent,
  createTask,
  systemClock,
  uuidIdGenerator,
} from '../../../domain/src/index.js';
import type { OfficeStorage } from './officeStorage.js';

const DEFAULT_DEPS: DomainDeps = { ids: uuidIdGenerator, clock: systemClock };

export interface OfficeSnapshot {
  projects: Project[];
  /** Every agent: they are global, not owned by the active project. */
  agents: AgentDefinition[];
  /** Memberships of the active project only. */
  memberships: ProjectAgent[];
  /** Tasks of the active project only. */
  tasks: Task[];
  activeProjectId?: ProjectId;
}

export interface CreateProjectCommand {
  name: string;
  description?: string;
}

export interface CreateAgentCommand {
  name: string;
  role: string;
  provider: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
}

export interface MembershipCommand {
  projectId: string;
  agentId: string;
}

export interface CreateTaskCommand {
  projectId: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
}

export class OfficeService {
  constructor(
    private readonly storage: OfficeStorage,
    private readonly deps: DomainDeps = DEFAULT_DEPS,
  ) {}

  private get repos(): Repositories {
    return this.storage.repos;
  }

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Everything the office needs to render, in one read.
   *
   * Memberships and tasks are scoped to the active project; agents are not,
   * because the Agent Library shows the whole office. With no active project
   * the two project-scoped lists come back empty rather than global — a UI that
   * has selected nothing should show nothing project-specific.
   */
  async snapshot(activeProjectId?: ProjectId): Promise<OfficeSnapshot> {
    const [projects, agents] = await Promise.all([
      this.repos.projects.list(),
      this.repos.agents.list(),
    ]);
    const active =
      activeProjectId && projects.some((p) => p.id === activeProjectId)
        ? activeProjectId
        : undefined;

    if (!active) {
      return { projects, agents, memberships: [], tasks: [] };
    }
    const [memberships, tasks] = await Promise.all([
      this.repos.projectAgents.listByProject(active),
      this.repos.tasks.listByProject(active),
    ]);
    return { projects, agents, memberships, tasks, activeProjectId: active };
  }

  // ── Commands ───────────────────────────────────────────────────

  async createProject(command: CreateProjectCommand): Promise<Project> {
    const project = createProject(
      { name: command.name, description: command.description },
      this.deps,
    );
    await this.repos.projects.put(project);
    return project;
  }

  async createAgent(command: CreateAgentCommand): Promise<AgentDefinition> {
    const agent = createAgentDefinition(
      {
        name: command.name,
        role: command.role,
        provider: command.provider,
        description: command.description,
        systemPrompt: command.systemPrompt,
        model: command.model,
      },
      this.deps,
    );
    await this.repos.agents.put(agent);
    return agent;
  }

  /**
   * Add an existing global agent to a project.
   *
   * Both ends are checked to exist first: the database would refuse a dangling
   * foreign key anyway, but a named error is more use to the UI than
   * "FOREIGN KEY constraint failed".
   */
  async addAgentToProject(command: MembershipCommand): Promise<ProjectAgent> {
    const projectId = asProjectId(command.projectId);
    const agentId = asAgentId(command.agentId);

    const [project, agent] = await Promise.all([
      this.repos.projects.get(projectId),
      this.repos.agents.get(agentId),
    ]);
    if (!project) {
      throw new Error(`project not found: ${projectId}`);
    }
    if (!agent) {
      throw new Error(`agent not found: ${agentId}`);
    }

    const existing = await this.repos.projectAgents.listByProject(projectId);
    assertNotAlreadyMember(projectId, agentId, existing);

    const membership = createProjectAgent({ projectId, agentId }, this.deps);
    await this.repos.projectAgents.put(membership);
    return membership;
  }

  /**
   * Remove a membership and nothing else.
   *
   * The global agent, its skills and its knowledge survive, as do its
   * memberships of other projects (ADR 005).
   */
  async removeAgentFromProject(command: MembershipCommand): Promise<boolean> {
    const projectId = asProjectId(command.projectId);
    const agentId = asAgentId(command.agentId);
    const membership = await this.repos.projectAgents.find(projectId, agentId);
    if (!membership) {
      return false;
    }
    return this.repos.projectAgents.delete(membership.id);
  }

  async createTask(command: CreateTaskCommand): Promise<Task> {
    const projectId = asProjectId(command.projectId);
    if (!(await this.repos.projects.get(projectId))) {
      throw new Error(`project not found: ${projectId}`);
    }
    const assignedAgentId =
      command.assignedAgentId === undefined ? undefined : asAgentId(command.assignedAgentId);
    if (assignedAgentId && !(await this.repos.agents.get(assignedAgentId))) {
      throw new Error(`agent not found: ${assignedAgentId}`);
    }

    const task = createTask(
      {
        projectId,
        title: command.title,
        description: command.description,
        assignedAgentId,
      },
      this.deps,
    );
    await this.repos.tasks.put(task);
    return task;
  }

  async getTask(taskId: TaskId): Promise<Task | null> {
    return this.repos.tasks.get(taskId);
  }

  async getAgent(agentId: AgentId): Promise<AgentDefinition | null> {
    return this.repos.agents.get(agentId);
  }
}

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
  AgentKnowledge,
  AgentSession,
  DomainDeps,
  KnowledgeType,
  OutputItem,
  Project,
  ProjectAgent,
  ProjectId,
  ProjectKnowledge,
  ProjectStatus,
  Repositories,
  ResourceRef,
  Skill,
  SkillKind,
  Task,
  TaskId,
  TaskInput,
  TaskPriority,
  TaskStatus,
} from '../../../domain/src/index.js';
import {
  asAgentId,
  asAgentKnowledgeId,
  asOutputId,
  asProjectId,
  asProjectKnowledgeId,
  assertDependenciesValid,
  assertNotAlreadyMember,
  assertParentValid,
  assignTask as assignTaskToAgent,
  asSkillId,
  asTaskId,
  createAgentDefinition,
  createAgentKnowledge as createAgentKnowledgeItem,
  createProject,
  createProjectAgent,
  createProjectKnowledge as createProjectKnowledgeItem,
  createSkill as createSkillDefinition,
  createTask,
  systemClock,
  transitionTask,
  unassignTask as unassignTaskFromAgent,
  updateAgentDefinition,
  updateAgentKnowledge as updateAgentKnowledgeItem,
  updateProject as updateProjectDefinition,
  updateProjectKnowledge as updateProjectKnowledgeItem,
  updateSkill as updateSkillDefinition,
  uuidIdGenerator,
} from '../../../domain/src/index.js';
import type { ReviewNote } from '../../../storage/src/index.js';
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
  priority?: TaskPriority;
  parentTaskId?: string;
  dependencies?: string[];
  inputs?: TaskInput[];
}

export interface ProjectKnowledgeView {
  item: ProjectKnowledge;
  content?: string;
  contentReadable: boolean;
}

export interface ProjectDetailView {
  project: Project;
  memberships: ProjectAgent[];
  knowledge: ProjectKnowledgeView[];
  tasks: Task[];
  /** Executions in this project, newest first. */
  sessions: AgentSession[];
  outputs: OutputItem[];
  /** Human review feedback, oldest first. Never agent knowledge. */
  reviewNotes: ReviewNote[];
}

export interface UpdateProjectCommand {
  projectId: string;
  name?: string;
  description?: string;
  status?: ProjectStatus;
  workspacePaths?: string[];
  defaultProvider?: string;
  defaultModel?: string;
}

export interface CreateProjectKnowledgeCommand {
  projectId: string;
  title: string;
  knowledgeType: KnowledgeType;
  content: string;
  tags?: string[];
}

export interface UpdateProjectKnowledgeCommand {
  knowledgeId: string;
  title?: string;
  knowledgeType?: KnowledgeType;
  content?: string;
  tags?: string[];
}

export interface UpdateTaskCommand {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  parentTaskId?: string;
  clearParentTask?: boolean;
  dependencies?: string[];
  inputs?: TaskInput[];
}

export interface AssignTaskCommand {
  taskId: string;
  agentId: string;
}

export interface SetTaskStatusCommand {
  taskId: string;
  status: TaskStatus;
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
    // A task assigned to someone who is no longer a member is an invalid
    // ownership the domain would never let us create, so it is not one we may
    // leave behind: the tasks are unassigned in the same transaction. A task
    // already in progress refuses to be unassigned, which refuses the removal.
    return this.storage.uow.run(async (repos) => {
      const tasks = await repos.tasks.listByProject(projectId);
      for (const task of tasks.filter((t) => t.assignedAgentId === agentId)) {
        await repos.tasks.put(unassignTaskFromAgent(task, this.deps.clock));
      }
      return repos.projectAgents.delete(membership.id);
    });
  }

  async createTask(command: CreateTaskCommand): Promise<Task> {
    const projectId = asProjectId(command.projectId);
    if (!(await this.repos.projects.get(projectId))) {
      throw new Error(`project not found: ${projectId}`);
    }
    // A task may be created with no agent at all — most are, at first.
    const assignedAgentId =
      command.assignedAgentId === undefined ? undefined : asAgentId(command.assignedAgentId);
    if (assignedAgentId) {
      await this.assertMember(projectId, assignedAgentId);
    }

    const task = createTask(
      {
        projectId,
        title: command.title,
        description: command.description,
        assignedAgentId,
        priority: command.priority,
        parentTaskId:
          command.parentTaskId === undefined ? undefined : asTaskId(command.parentTaskId),
        dependencies: command.dependencies?.map(asTaskId),
        inputs: command.inputs,
      },
      this.deps,
    );
    // Both graphs are validated before the task exists, so an unexecutable
    // graph is never written.
    const graph = await this.graphFor(task);
    assertParentValid(task, graph);
    assertDependenciesValid(task, graph);
    await this.repos.tasks.put(task);
    return task;
  }

  async getTask(taskId: TaskId): Promise<Task | null> {
    return this.repos.tasks.get(taskId);
  }

  async getAgent(agentId: AgentId): Promise<AgentDefinition | null> {
    return this.repos.agents.get(agentId);
  }

  // ── Agent configuration ────────────────────────────────────────
  //
  // Everything below concerns what an agent permanently owns. No method here
  // reads a project, a task or project knowledge: an agent's configuration
  // cannot be changed by project activity (ADR 005).

  /**
   * One agent with its own skills and knowledge.
   *
   * Knowledge content is resolved through the BlobStore. A reference this build
   * cannot read inline (a `file` or `url` location) comes back without content
   * and flagged unreadable, rather than failing the whole read — the reference
   * itself stays exactly as stored.
   */
  async agentDetail(agentIdRaw: string): Promise<AgentDetailView | null> {
    const agentId = asAgentId(agentIdRaw);
    const agent = await this.repos.agents.get(agentId);
    if (!agent) {
      return null;
    }
    const [skills, knowledge] = await Promise.all([
      this.repos.skills.listByAgent(agentId),
      this.repos.agentKnowledge.listByAgent(agentId),
    ]);
    const resolved = await Promise.all(
      knowledge.map(async (item) => ({
        item,
        ...(await this.readContent(item.location)),
      })),
    );
    return { agent, skills, knowledge: resolved };
  }

  private async readContent(
    location: ResourceRef,
  ): Promise<{ content?: string; contentReadable: boolean }> {
    try {
      return { content: await this.repos.blobs.read(location), contentReadable: true };
    } catch {
      // A file:// or url:// reference, or a blob whose file has gone. Neither is
      // an error worth failing the whole detail view for.
      return { contentReadable: false };
    }
  }

  async updateAgent(command: UpdateAgentCommand): Promise<AgentDefinition> {
    const agentId = asAgentId(command.agentId);
    const agent = await this.repos.agents.get(agentId);
    if (!agent) {
      throw new Error(`agent not found: ${agentId}`);
    }
    const updated = updateAgentDefinition(
      agent,
      {
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.role === undefined ? {} : { role: command.role }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.systemPrompt === undefined ? {} : { systemPrompt: command.systemPrompt }),
        ...(command.model === undefined ? {} : { model: command.model }),
      },
      this.deps.clock,
    );
    await this.repos.agents.put(updated);
    return updated;
  }

  // ── Skills (owned by one agent) ────────────────────────────────

  async createSkill(command: CreateSkillCommand): Promise<Skill> {
    const agentId = asAgentId(command.agentId);
    if (!(await this.repos.agents.get(agentId))) {
      throw new Error(`agent not found: ${agentId}`);
    }
    const skill = createSkillDefinition(
      {
        agentId,
        slug: command.slug,
        name: command.name,
        kind: command.kind,
        description: command.description,
        source: { origin: 'content', ref: { store: 'inline', content: command.content ?? '' } },
        requiredTools: command.requiredTools,
      },
      this.deps,
    );
    // The unique index would refuse this anyway; checking first turns a raw
    // SQLITE_CONSTRAINT into something the UI can show a person.
    await this.assertSlugFree(agentId, skill.slug, null);
    await this.repos.skills.put(skill);
    return skill;
  }

  async updateSkill(command: UpdateSkillCommand): Promise<Skill> {
    const skillId = asSkillId(command.skillId);
    const skill = await this.repos.skills.get(skillId);
    if (!skill) {
      throw new Error(`skill not found: ${skillId}`);
    }
    const updated = updateSkillDefinition(
      skill,
      {
        ...(command.slug === undefined ? {} : { slug: command.slug }),
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.kind === undefined ? {} : { kind: command.kind }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.requiredTools === undefined ? {} : { requiredTools: command.requiredTools }),
        ...(command.content === undefined
          ? {}
          : {
              source: {
                origin: 'content' as const,
                ref: { store: 'inline' as const, content: command.content },
              },
            }),
      },
      this.deps.clock,
    );
    if (updated.slug !== skill.slug) {
      await this.assertSlugFree(skill.agentId, updated.slug, skill.id);
    }
    await this.repos.skills.put(updated);
    return updated;
  }

  async deleteSkill(skillIdRaw: string): Promise<boolean> {
    return this.repos.skills.delete(asSkillId(skillIdRaw));
  }

  private async assertSlugFree(
    agentId: AgentId,
    slug: string,
    allowId: string | null,
  ): Promise<void> {
    const existing = await this.repos.skills.findBySlug(agentId, slug);
    if (existing && existing.id !== allowId) {
      throw new Error(`this agent already has a skill with the slug "${slug}"`);
    }
  }

  // ── Agent knowledge (permanent, agent-owned) ───────────────────

  /**
   * The only way agent knowledge is created. Nothing is ingested from project
   * work, task content or outputs — that is the whole point of the boundary.
   */
  async createAgentKnowledge(command: CreateAgentKnowledgeCommand): Promise<AgentKnowledge> {
    const agentId = asAgentId(command.agentId);
    if (!(await this.repos.agents.get(agentId))) {
      throw new Error(`agent not found: ${agentId}`);
    }
    // Blob and row in one transaction: a half-written item would either leak a
    // file nothing points at or leave a row pointing at nothing.
    return this.storage.uow.run(async (repos) => {
      const location = await repos.blobs.write(
        { owner: { kind: 'agent', agentId }, name: `${command.title}.md` },
        command.content,
      );
      const item = createAgentKnowledgeItem(
        {
          agentId,
          type: command.knowledgeType,
          title: command.title,
          // Authored by the operator in the agent's own library.
          source: { origin: 'human' },
          location,
          tags: command.tags,
        },
        this.deps,
      );
      await repos.agentKnowledge.put(item);
      return item;
    });
  }

  async updateAgentKnowledge(command: UpdateAgentKnowledgeCommand): Promise<AgentKnowledge> {
    const knowledgeId = asAgentKnowledgeId(command.knowledgeId);
    const item = await this.repos.agentKnowledge.get(knowledgeId);
    if (!item) {
      throw new Error(`agent knowledge not found: ${knowledgeId}`);
    }
    return this.storage.uow.run(async (repos) => {
      let location: ResourceRef | undefined;
      if (command.content !== undefined) {
        location = await repos.blobs.write(
          {
            owner: { kind: 'agent', agentId: item.agentId },
            name: `${command.title ?? item.title}.md`,
          },
          command.content,
        );
      }
      const updated = updateAgentKnowledgeItem(
        item,
        {
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.knowledgeType === undefined ? {} : { type: command.knowledgeType }),
          ...(command.tags === undefined ? {} : { tags: command.tags }),
          ...(location === undefined ? {} : { location }),
        },
        this.deps.clock,
      );
      await repos.agentKnowledge.put(updated);
      if (location) {
        // Drop the superseded blob only after the row points at the new one.
        await repos.blobs.delete(item.location);
      }
      return updated;
    });
  }

  // ── Project workspace ──────────────────────────────────────────
  //
  // A project's temporary working context: its own definition, its members,
  // its knowledge and its tasks. No method here writes an AgentDefinition, a
  // Skill or an AgentKnowledge — project work never becomes agent memory.

  /** One project with everything the workspace shows, in one read. */
  async projectDetail(projectIdRaw: string): Promise<ProjectDetailView | null> {
    const projectId = asProjectId(projectIdRaw);
    const project = await this.repos.projects.get(projectId);
    if (!project) {
      return null;
    }
    const [memberships, knowledge, tasks, sessions, outputs, reviewNotes] = await Promise.all([
      this.repos.projectAgents.listByProject(projectId),
      this.repos.projectKnowledge.listByProject(projectId),
      this.repos.tasks.listByProject(projectId),
      this.repos.sessions.listByProject(projectId),
      this.repos.outputs.listByProject(projectId),
      this.storage.reviews.listByProject(projectId),
    ]);
    const resolved = await Promise.all(
      knowledge.map(async (item) => ({ item, ...(await this.readContent(item.location)) })),
    );
    // Newest run first: the one the operator just started is the one they want.
    const ordered = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      project,
      memberships,
      knowledge: resolved,
      tasks,
      sessions: ordered,
      outputs,
      reviewNotes,
    };
  }

  /** One output's text, resolved through the BlobStore. */
  async outputContent(
    outputIdRaw: string,
  ): Promise<{ output: OutputItem; content?: string; contentReadable: boolean } | null> {
    const output = await this.repos.outputs.get(asOutputId(outputIdRaw));
    if (!output) {
      return null;
    }
    return { output, ...(await this.readContent(output.location)) };
  }

  async updateProject(command: UpdateProjectCommand): Promise<Project> {
    const projectId = asProjectId(command.projectId);
    const project = await this.repos.projects.get(projectId);
    if (!project) {
      throw new Error(`project not found: ${projectId}`);
    }
    const settings = {
      ...(command.workspacePaths === undefined ? {} : { workspacePaths: command.workspacePaths }),
      ...(command.defaultProvider === undefined
        ? {}
        : { defaultProvider: command.defaultProvider }),
      ...(command.defaultModel === undefined ? {} : { defaultModel: command.defaultModel }),
    };
    const updated = updateProjectDefinition(
      project,
      {
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.status === undefined ? {} : { status: command.status }),
        ...(Object.keys(settings).length === 0 ? {} : { settings }),
      },
      this.deps.clock,
    );
    await this.repos.projects.put(updated);
    return updated;
  }

  // ── Project knowledge (owned by one project) ───────────────────

  async createProjectKnowledge(command: CreateProjectKnowledgeCommand): Promise<ProjectKnowledge> {
    const projectId = asProjectId(command.projectId);
    if (!(await this.repos.projects.get(projectId))) {
      throw new Error(`project not found: ${projectId}`);
    }
    return this.storage.uow.run(async (repos) => {
      // Owned by the project, in the metadata and in the blob namespace alike.
      const location = await repos.blobs.write(
        { owner: { kind: 'project', projectId }, name: `${command.title}.md` },
        command.content,
      );
      const item = createProjectKnowledgeItem(
        {
          projectId,
          type: command.knowledgeType,
          title: command.title,
          source: { origin: 'human' },
          location,
          tags: command.tags,
        },
        this.deps,
      );
      await repos.projectKnowledge.put(item);
      return item;
    });
  }

  async updateProjectKnowledge(command: UpdateProjectKnowledgeCommand): Promise<ProjectKnowledge> {
    const knowledgeId = asProjectKnowledgeId(command.knowledgeId);
    const item = await this.repos.projectKnowledge.get(knowledgeId);
    if (!item) {
      throw new Error(`project knowledge not found: ${knowledgeId}`);
    }
    return this.storage.uow.run(async (repos) => {
      let location: ResourceRef | undefined;
      if (command.content !== undefined) {
        location = await repos.blobs.write(
          {
            owner: { kind: 'project', projectId: item.projectId },
            name: `${command.title ?? item.title}.md`,
          },
          command.content,
        );
      }
      const updated = updateProjectKnowledgeItem(
        item,
        {
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.knowledgeType === undefined ? {} : { type: command.knowledgeType }),
          ...(command.tags === undefined ? {} : { tags: command.tags }),
          ...(location === undefined ? {} : { location }),
        },
        this.deps.clock,
      );
      await repos.projectKnowledge.put(updated);
      if (location) {
        await repos.blobs.delete(item.location);
      }
      return updated;
    });
  }

  async deleteProjectKnowledge(knowledgeIdRaw: string): Promise<boolean> {
    const knowledgeId = asProjectKnowledgeId(knowledgeIdRaw);
    const item = await this.repos.projectKnowledge.get(knowledgeId);
    if (!item) {
      return false;
    }
    return this.storage.uow.run(async (repos) => {
      const removed = await repos.projectKnowledge.delete(knowledgeId);
      if (removed) {
        await repos.blobs.delete(item.location);
      }
      return removed;
    });
  }

  // ── Tasks ──────────────────────────────────────────────────────

  /**
   * Edit a task's own fields.
   *
   * Status and assignment are NOT here: the domain guards those with a
   * transition table and assignment rules, and they have their own methods.
   *
   * The frozen M1 domain ships no `updateTask`/`TaskPatch` (every other entity
   * has one), so the patch is composed here and then handed to the domain's own
   * graph validators. See the phase report.
   */
  async updateTask(command: UpdateTaskCommand): Promise<Task> {
    const taskId = asTaskId(command.taskId);
    const task = await this.repos.tasks.get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    const title = command.title === undefined ? task.title : command.title.trim();
    if (!title) {
      throw new Error('task.title must not be empty');
    }

    const updated: Task = {
      ...task,
      title,
      description:
        command.description === undefined ? task.description : command.description.trim(),
      priority: command.priority ?? task.priority,
      dependencies:
        command.dependencies === undefined ? task.dependencies : command.dependencies.map(asTaskId),
      inputs: command.inputs === undefined ? task.inputs : [...command.inputs],
      updatedAt: this.deps.clock.now(),
    };
    if (command.clearParentTask) {
      delete updated.parentTaskId;
    } else if (command.parentTaskId !== undefined) {
      updated.parentTaskId = asTaskId(command.parentTaskId);
    }

    const graph = await this.graphFor(updated);
    assertParentValid(updated, graph);
    assertDependenciesValid(updated, graph);
    await this.repos.tasks.put(updated);
    return updated;
  }

  /**
   * The graph a task is validated against: its project's tasks, plus any task
   * it names that is not among them.
   *
   * Without the second half, an id belonging to another project looks merely
   * unknown, and the domain reports "does not exist" instead of the
   * cross-project violation it actually is.
   */
  private async graphFor(task: Task): Promise<Task[]> {
    const graph = await this.repos.tasks.listByProject(task.projectId);
    const known = new Set(graph.map((t) => t.id));
    const referenced = [...task.dependencies, ...(task.parentTaskId ? [task.parentTaskId] : [])];
    for (const id of referenced) {
      if (known.has(id)) {
        continue;
      }
      known.add(id);
      const referencedTask = await this.repos.tasks.get(id);
      if (referencedTask) {
        graph.push(referencedTask);
      }
    }
    return graph;
  }

  /** Assign a task to an agent that is a member of the task's project. */
  async assignTask(command: AssignTaskCommand): Promise<Task> {
    const taskId = asTaskId(command.taskId);
    const task = await this.repos.tasks.get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    const agentId = asAgentId(command.agentId);
    await this.assertMember(task.projectId, agentId);
    const updated = assignTaskToAgent(task, agentId, this.deps.clock);
    await this.repos.tasks.put(updated);
    return updated;
  }

  async unassignTask(taskIdRaw: string): Promise<Task> {
    const taskId = asTaskId(taskIdRaw);
    const task = await this.repos.tasks.get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    const updated = unassignTaskFromAgent(task, this.deps.clock);
    await this.repos.tasks.put(updated);
    return updated;
  }

  /**
   * Accept a reviewed result.
   *
   * The human half of the cycle: no runtime is involved, no output is touched,
   * and the run history stays exactly as it is. Only the domain's own
   * review → done transition moves.
   */
  async acceptTask(taskIdRaw: string): Promise<Task> {
    const taskId = asTaskId(taskIdRaw);
    const task = await this.repos.tasks.get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    if (task.status !== 'review') {
      throw new Error(`only a task in review can be accepted (this one is "${task.status}")`);
    }
    const accepted = transitionTask(task, 'done', this.deps.clock);
    await this.repos.tasks.put(accepted);
    return accepted;
  }

  /** Move a task through the domain's status machine, dependencies and all. */
  async setTaskStatus(command: SetTaskStatusCommand): Promise<Task> {
    const taskId = asTaskId(command.taskId);
    const task = await this.repos.tasks.get(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    // The domain does no I/O, so the dependency statuses it needs to decide
    // whether work may start are fetched here and handed over.
    const dependencies = await this.repos.tasks.listDependencies(taskId);
    const updated = transitionTask(task, command.status, this.deps.clock, {
      dependencyStatuses: dependencies.map((d) => d.status),
    });
    await this.repos.tasks.put(updated);
    return updated;
  }

  /**
   * Delete a task and the edges that pointed at it.
   *
   * `dependencies` is a stored list, not a foreign key, so a plain delete would
   * leave ids behind that the graph validator later reports as unknown — the
   * next edit of an untouched task would fail. The children's `parentTaskId` is
   * a real foreign key and the database clears it.
   */
  async deleteTask(taskIdRaw: string): Promise<boolean> {
    const taskId = asTaskId(taskIdRaw);
    const task = await this.repos.tasks.get(taskId);
    if (!task) {
      return false;
    }
    return this.storage.uow.run(async (repos) => {
      for (const other of await repos.tasks.listByProject(task.projectId)) {
        if (other.id !== taskId && other.dependencies.includes(taskId)) {
          await repos.tasks.put({
            ...other,
            dependencies: other.dependencies.filter((id) => id !== taskId),
            updatedAt: this.deps.clock.now(),
          });
        }
      }
      return repos.tasks.delete(taskId);
    });
  }

  /** An agent may only be given work in a project it belongs to. */
  private async assertMember(projectId: ProjectId, agentId: AgentId): Promise<void> {
    if (!(await this.repos.agents.get(agentId))) {
      throw new Error(`agent not found: ${agentId}`);
    }
    if (!(await this.repos.projectAgents.find(projectId, agentId))) {
      throw new Error('agent is not a member of this project');
    }
  }

  async deleteAgentKnowledge(knowledgeIdRaw: string): Promise<boolean> {
    const knowledgeId = asAgentKnowledgeId(knowledgeIdRaw);
    const item = await this.repos.agentKnowledge.get(knowledgeId);
    if (!item) {
      return false;
    }
    return this.storage.uow.run(async (repos) => {
      const removed = await repos.agentKnowledge.delete(knowledgeId);
      if (removed) {
        await repos.blobs.delete(item.location);
      }
      return removed;
    });
  }
}

export interface AgentKnowledgeView {
  item: AgentKnowledge;
  content?: string;
  contentReadable: boolean;
}

export interface AgentDetailView {
  agent: AgentDefinition;
  skills: Skill[];
  knowledge: AgentKnowledgeView[];
}

export interface UpdateAgentCommand {
  agentId: string;
  name?: string;
  role?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
}

export interface CreateSkillCommand {
  agentId: string;
  slug: string;
  name: string;
  kind: SkillKind;
  description?: string;
  content?: string;
  requiredTools?: string[];
}

export interface UpdateSkillCommand {
  skillId: string;
  slug?: string;
  name?: string;
  kind?: SkillKind;
  description?: string;
  content?: string;
  requiredTools?: string[];
}

export interface CreateAgentKnowledgeCommand {
  agentId: string;
  title: string;
  knowledgeType: KnowledgeType;
  content: string;
  tags?: string[];
}

export interface UpdateAgentKnowledgeCommand {
  knowledgeId: string;
  title?: string;
  knowledgeType?: KnowledgeType;
  content?: string;
  tags?: string[];
}

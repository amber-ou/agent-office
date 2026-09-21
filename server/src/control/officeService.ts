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
  asOutputId,
  asProjectId,
  asProjectKnowledgeId,
  assertDependenciesValid,
  assertNotAlreadyMember,
  assertParentValid,
  assignTask as assignTaskToAgent,
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
import type { AgentFileStore, ReviewNote } from '../../../storage/src/index.js';
import type { OfficeStorage } from './officeStorage.js';
import { awaitAgentFileMigration, awaitCcBridge, runCcBridgeSync } from './officeStorage.js';

const DEFAULT_DEPS: DomainDeps = { ids: uuidIdGenerator, clock: systemClock };

export interface OfficeSnapshot {
  sessions: AgentSession[];
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

  /** Agent-owned files: the authoritative source for agent configuration. */
  private get files(): AgentFileStore {
    return this.storage.agentFiles;
  }

  /**
   * Brings the Claude Code discovery bridge (CC fields, office.json, the
   * knowledge index, qualified skill names, the .claude/ links) up to date
   * for whatever this command just changed.
   *
   * The boot-time pass in officeStorage.ts runs exactly once, when this
   * process's storage first opens — an agent created or edited afterwards
   * would otherwise never get linked at all. Every command below that writes
   * to `this.files` awaits this immediately after, so a client that gets a
   * response back always sees a fully bridged agent, not one that catches up
   * on some later, unrelated open.
   *
   * A bridge failure here never fails the command that triggered it — the
   * mutation itself already succeeded and must not be undone over a linking
   * problem — it is only logged, the same as the boot-time pass does.
   */
  private async syncAfterFileWrite(): Promise<void> {
    // The boot-time pass (officeStorage.ts) is fire-and-forget: nothing
    // otherwise waits for it, so without this it can execute AFTER a
    // mutation made here, read whatever the mutation (or a test simulating
    // damage) just wrote, and wrap that in bridge output nobody asked for —
    // observed as a boot-time sync clobbering a deliberately-conflicted file
    // that had already been left alone. Awaiting both first guarantees the
    // boot-time pass has fully settled — including its OWN sync, if this
    // agent was already migrated when the process opened — before this
    // mutation's sync ever runs, so there is exactly one sync in flight for
    // this agent, never two racing in an unpredictable order.
    await awaitAgentFileMigration();
    await awaitCcBridge();
    // Queued behind that (a no-op wait, since both settled above) and every
    // other mutation's sync (see runCcBridgeSync) — never runs concurrently
    // with another sync over the same agent's files. Errors are logged
    // there, not thrown here: the mutation that triggered this already
    // succeeded and must not be undone over a linking problem.
    await runCcBridgeSync(this.storage);
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
    const sessions = (
      await Promise.all(agents.map((agent) => this.repos.sessions.listByAgent(agent.id)))
    ).flat();

    if (!active) {
      return { projects, agents, memberships: [], tasks: [], sessions };
    }
    const [memberships, tasks] = await Promise.all([
      this.repos.projectAgents.listByProject(active),
      this.repos.tasks.listByProject(active),
    ]);
    return { projects, agents, memberships, tasks, sessions, activeProjectId: active };
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
    // A new agent owns its files from the start: the directory exists, its
    // instructions are on disk, and it is authoritative immediately — there is
    // no legacy copy for it to conflict with.
    const now = this.deps.clock.now();
    await this.files.ensureAgent(agent.id, now);
    await this.files.writeInstructions(agent.id, agent.systemPrompt);
    await this.files.markMigrated(agent.id, now);
    // Recorded in the database too: that record, not the marker inside the
    // directory, is what later tells "file-backed" apart from "never moved".
    await this.storage.agentMigrations.markMigrated(agent.id, now);
    await this.syncAfterFileWrite();
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
   * Once an agent has been migrated, its instructions, skills and foundational
   * knowledge come from ITS OWN files — the database keeps the registry entry
   * (name, role, provider, model) and nothing editable that the files also
   * hold. An agent whose migration hit a conflict still reads from the
   * database, and says so, until a person resolves it.
   */
  async agentDetail(agentIdRaw: string): Promise<AgentDetailView | null> {
    const agentId = asAgentId(agentIdRaw);
    const stored = await this.repos.agents.get(agentId);
    if (!stored) {
      return null;
    }
    const source = await this.configSource(agentId);
    if (source === 'database') {
      return this.legacyAgentDetail(stored);
    }

    // `damaged` still reads the files — whatever survived — and says so. It
    // never falls back to the legacy rows: stale content presented as current
    // is worse than visibly missing content.
    // Damaged reads nothing from the row either: the instructions in it are
    // whatever was true at migration time, and showing those as the agent's
    // current instructions is the same lie as rebuilding from them.
    const agent =
      source === 'damaged' ? { ...stored, systemPrompt: '' } : await this.hydrate(stored);
    const [skills, knowledge] = await Promise.all([
      this.files.listSkills(agentId),
      this.files.listKnowledge(agentId),
    ]);
    return {
      agent,
      skills: skills.map((s) => s.skill),
      knowledge: knowledge.map((k) => ({
        item: k.item,
        content: k.content,
        contentReadable: true,
      })),
      fileBacked: source === 'files',
      ...(source === 'damaged'
        ? {
            configIssue:
              'This agent is file-backed but its files are missing or unreadable. Nothing was rebuilt from the database. Restore the agents directory from a backup.',
          }
        : {}),
    };
  }

  /** The pre-M5 read path. Used only for an agent whose migration is blocked. */
  private async legacyAgentDetail(agent: AgentDefinition): Promise<AgentDetailView> {
    const [skills, knowledge] = await Promise.all([
      this.repos.skills.listByAgent(agent.id),
      this.repos.agentKnowledge.listByAgent(agent.id),
    ]);
    const resolved = await Promise.all(
      knowledge.map(async (item) => ({ item, ...(await this.readContent(item.location)) })),
    );
    return {
      agent,
      skills,
      knowledge: resolved,
      fileBacked: false,
      configIssue:
        "This agent's files disagree with its stored configuration, so it is still read from the database and cannot be edited. Both copies have been kept.",
    };
  }

  /**
   * The registry row plus whatever the files own.
   *
   * `systemPrompt` lives in `instructions.md` once an agent is file-backed, so
   * the row's copy — left untouched for recovery — is never what is read.
   */
  private async hydrate(agent: AgentDefinition): Promise<AgentDefinition> {
    const instructions = await this.files.readInstructions(agent.id);
    return instructions === null ? agent : { ...agent, systemPrompt: instructions };
  }

  /**
   * Where this agent's configuration is read from, and whether that is healthy.
   *
   * Waits for the open database's migration first: an agent that is only
   * halfway through moving to files is not one anybody should be reading from,
   * or refusing writes for.
   *
   * The three answers are genuinely different situations, and collapsing them
   * loses data:
   *
   *   files     the files own it, and they are there.
   *   database  it has not moved yet, or its first migration hit a conflict.
   *   damaged   the database says it moved, and its files are gone. Serving the
   *             legacy rows here would quietly hand back a version of the agent
   *             that may be months out of date, as if nothing were wrong.
   */
  private async configSource(agentId: AgentId): Promise<AgentConfigSource> {
    await awaitAgentFileMigration();
    if (!(await this.storage.agentMigrations.isMigrated(agentId))) {
      return 'database';
    }
    return (await this.files.readInstructions(agentId)) === null ? 'damaged' : 'files';
  }

  /**
   * Refuse to write agent configuration that files do not own and hold.
   *
   * Writing to a conflicted agent would mean editing one of two disagreeing
   * copies; writing to a damaged one would bury whatever is still recoverable.
   */
  private async requireWritableFiles(agentId: AgentId): Promise<void> {
    const source = await this.configSource(agentId);
    if (source === 'files') {
      return;
    }
    throw new Error(
      source === 'damaged'
        ? 'this agent is file-backed but its files are missing; restore the agents directory from a backup before editing it'
        : "this agent's files conflict with its stored configuration; resolve the conflict before editing it",
    );
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
    const fileBacked = (await this.configSource(agentId)) === 'files';
    if (command.systemPrompt !== undefined) {
      await this.requireWritableFiles(agentId);
    }

    // The registry fields stay in the database; the instructions go to the file
    // that owns them. Renaming an agent touches no path: its directory is its
    // id (ADR 007).
    const updated = updateAgentDefinition(
      agent,
      {
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.role === undefined ? {} : { role: command.role }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.model === undefined ? {} : { model: command.model }),
        ...(fileBacked || command.systemPrompt === undefined
          ? {}
          : { systemPrompt: command.systemPrompt }),
      },
      this.deps.clock,
    );
    await this.repos.agents.put(updated);
    if (command.systemPrompt !== undefined) {
      await this.files.writeInstructions(agentId, command.systemPrompt);
    }
    await this.syncAfterFileWrite();
    return this.hydrate(updated);
  }

  // ── Skills (owned by one agent) ────────────────────────────────

  async createSkill(command: CreateSkillCommand): Promise<Skill> {
    const agentId = asAgentId(command.agentId);
    if (!(await this.repos.agents.get(agentId))) {
      throw new Error(`agent not found: ${agentId}`);
    }
    await this.requireWritableFiles(agentId);

    // Built through the domain factory so its rules — a non-empty name, a
    // normalised slug — still decide what a skill is; the file is where it goes.
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
    await this.assertSlugFree(agentId, skill.slug, null);
    const stored = await this.files.writeSkill(
      agentId,
      skill.id,
      {
        slug: skill.slug,
        name: skill.name,
        kind: skill.kind,
        description: skill.description,
        content: command.content ?? '',
        requiredTools: skill.requiredTools,
      },
      { createdAt: skill.createdAt, updatedAt: skill.updatedAt },
    );
    await this.syncAfterFileWrite();
    return stored.skill;
  }

  async updateSkill(command: UpdateSkillCommand): Promise<Skill> {
    const agentId = asAgentId(command.agentId);
    await this.requireWritableFiles(agentId);
    // The id is only ever looked up under the owning agent, so one agent cannot
    // reach another's skill by guessing an id.
    const existing = await this.files.readSkill(agentId, command.skillId);
    if (!existing) {
      throw new Error(`skill not found: ${command.skillId}`);
    }
    const updated = updateSkillDefinition(
      existing.skill,
      {
        ...(command.slug === undefined ? {} : { slug: command.slug }),
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.kind === undefined ? {} : { kind: command.kind }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.requiredTools === undefined ? {} : { requiredTools: command.requiredTools }),
      },
      this.deps.clock,
    );
    if (updated.slug !== existing.skill.slug) {
      await this.assertSlugFree(agentId, updated.slug, existing.skill.id);
    }
    const stored = await this.files.writeSkill(
      agentId,
      existing.skill.id,
      {
        slug: updated.slug,
        name: updated.name,
        kind: updated.kind,
        description: updated.description,
        content: command.content ?? existing.content,
        requiredTools: updated.requiredTools,
      },
      { createdAt: existing.skill.createdAt, updatedAt: updated.updatedAt },
    );
    await this.syncAfterFileWrite();
    return stored.skill;
  }

  async deleteSkill(command: DeleteSkillCommand): Promise<boolean> {
    const agentId = asAgentId(command.agentId);
    await this.requireWritableFiles(agentId);
    const deleted = await this.files.deleteSkill(agentId, command.skillId);
    // Note: this only refreshes what still exists. A deleted skill's own
    // .claude/skills/<qualified-name>/ link is left in place, pointing at a
    // now-missing directory — the bridge does not remove links yet.
    await this.syncAfterFileWrite();
    return deleted;
  }

  private async assertSlugFree(
    agentId: AgentId,
    slug: string,
    allowId: string | null,
  ): Promise<void> {
    const existing = await this.files.listSkills(agentId);
    if (existing.some((s) => s.skill.slug === slug && s.skill.id !== allowId)) {
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
    await this.requireWritableFiles(agentId);
    const item = createAgentKnowledgeItem(
      {
        agentId,
        type: command.knowledgeType,
        title: command.title,
        // Authored by the operator in the agent's own library.
        source: { origin: 'human' },
        // Replaced by the file store with the file's own path.
        location: { store: 'inline', content: '' },
        tags: command.tags,
      },
      this.deps,
    );
    const stored = await this.files.writeKnowledge(
      agentId,
      item.id,
      { title: item.title, type: item.type, content: command.content, tags: item.tags },
      { createdAt: item.createdAt, updatedAt: item.updatedAt },
    );
    await this.syncAfterFileWrite(); // rebuilds knowledge/index.md
    return stored.item;
  }

  async updateAgentKnowledge(command: UpdateAgentKnowledgeCommand): Promise<AgentKnowledge> {
    const agentId = asAgentId(command.agentId);
    await this.requireWritableFiles(agentId);
    const existing = await this.files.readKnowledge(agentId, command.knowledgeId);
    if (!existing) {
      throw new Error(`agent knowledge not found: ${command.knowledgeId}`);
    }
    const updated = updateAgentKnowledgeItem(
      existing.item,
      {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.knowledgeType === undefined ? {} : { type: command.knowledgeType }),
        ...(command.tags === undefined ? {} : { tags: command.tags }),
      },
      this.deps.clock,
    );
    const stored = await this.files.writeKnowledge(
      agentId,
      existing.item.id,
      {
        title: updated.title,
        type: updated.type,
        content: command.content ?? existing.content,
        tags: updated.tags,
      },
      { createdAt: existing.item.createdAt, updatedAt: updated.updatedAt },
    );
    await this.syncAfterFileWrite(); // rebuilds knowledge/index.md
    return stored.item;
  }

  async deleteAgentKnowledge(command: DeleteAgentKnowledgeCommand): Promise<boolean> {
    const agentId = asAgentId(command.agentId);
    await this.requireWritableFiles(agentId);
    const deleted = await this.files.deleteKnowledge(agentId, command.knowledgeId);
    await this.syncAfterFileWrite(); // rebuilds knowledge/index.md without it
    return deleted;
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
}

export interface AgentKnowledgeView {
  item: AgentKnowledge;
  content?: string;
  contentReadable: boolean;
}

/** Where an agent's configuration is read from right now. */
export type AgentConfigSource = 'files' | 'database' | 'damaged';

export interface AgentDetailView {
  agent: AgentDefinition;
  skills: Skill[];
  knowledge: AgentKnowledgeView[];
  /** True only when the files own this agent AND they are readable. */
  fileBacked: boolean;
  /** Set when something needs a person: a conflict, or missing files. */
  configIssue?: string;
}

export interface DeleteSkillCommand {
  agentId: string;
  skillId: string;
}

export interface DeleteAgentKnowledgeCommand {
  agentId: string;
  knowledgeId: string;
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
  /** The owning agent. Every agent-scoped call carries it, so no id alone
   *  reaches another agent's file. */
  agentId: string;
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
  agentId: string;
  knowledgeId: string;
  title?: string;
  knowledgeType?: KnowledgeType;
  content?: string;
  tags?: string[];
}

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
  DomainDeps,
  KnowledgeType,
  Project,
  ProjectAgent,
  ProjectId,
  Repositories,
  ResourceRef,
  Skill,
  SkillKind,
  Task,
  TaskId,
} from '../../../domain/src/index.js';
import {
  asAgentId,
  asAgentKnowledgeId,
  asProjectId,
  assertNotAlreadyMember,
  asSkillId,
  createAgentDefinition,
  createAgentKnowledge as createAgentKnowledgeItem,
  createProject,
  createProjectAgent,
  createSkill as createSkillDefinition,
  createTask,
  systemClock,
  updateAgentDefinition,
  updateAgentKnowledge as updateAgentKnowledgeItem,
  updateSkill as updateSkillDefinition,
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

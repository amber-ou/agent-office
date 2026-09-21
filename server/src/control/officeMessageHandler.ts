/**
 * Transport edge of the Agent Office control plane.
 *
 * Translates the seven control `ClientMessage`s into `OfficeService` calls and
 * answers with a full `officeState` snapshot. It knows about messages and
 * errors; it contains no domain rules and touches no repository directly.
 *
 * Every mutation replies with the whole snapshot. The data set is small, and a
 * snapshot cannot drift out of step with the database the way a stream of
 * incremental patches can.
 *
 * The active project is per-connection UI state, not persisted: which project
 * you are looking at is a property of the window, not of the office.
 */

import type {
  AgentDetail,
  ClientMessage,
  OfficeState,
  OfficeTaskInput,
  ProjectDetail,
  ServerMessage,
} from '../../../core/src/messages.js';
import type { AgentSession, OutputItem } from '../../../domain/src/index.js';
import type {
  AgentDefinition,
  KnowledgeType,
  Project,
  ProjectAgent,
  ProjectId,
  ProjectStatus,
  Skill,
  SkillKind,
  Task,
  TaskInput,
  TaskPriority,
  TaskStatus,
} from '../../../domain/src/index.js';
import { asOutputId, asProjectId, asProjectKnowledgeId } from '../../../domain/src/index.js';
import type { ReviewNote } from '../../../storage/src/index.js';
import type { AgentKnowledgeView, ProjectKnowledgeView } from './officeService.js';
import { OfficeService } from './officeService.js';
import { getOfficeStorage, officeStorageStatus } from './officeStorage.js';
import type { RunChange } from './taskRunner.js';
import { getTaskRunner } from './taskRunner.js';

/** The control-plane message types this handler owns. */
const OFFICE_CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'requestOffice',
  'createProject',
  'setActiveProject',
  'createAgent',
  'addAgentToProject',
  'removeAgentFromProject',
  'createTask',
  'requestAgentDetail',
  'updateAgent',
  'createSkill',
  'updateSkill',
  'deleteSkill',
  'createAgentKnowledge',
  'updateAgentKnowledge',
  'deleteAgentKnowledge',
  'requestProjectDetail',
  'updateProject',
  'createProjectKnowledge',
  'updateProjectKnowledge',
  'deleteProjectKnowledge',
  'updateTask',
  'assignTask',
  'unassignTask',
  'setTaskStatus',
  'deleteTask',
  'runTask',
  'cancelTaskRun',
  'requestOutputContent',
  'acceptTask',
  'requestTaskChanges',
]);

export function isOfficeClientMessage(type: unknown): boolean {
  return typeof type === 'string' && OFFICE_CLIENT_MESSAGE_TYPES.has(type);
}

type Send = (message: Record<string, unknown>) => void;

/** Typed ServerMessage -> the transport's untyped record, at one place. */
function asWire(message: ServerMessage): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

/**
 * Per-connection control-plane state.
 *
 * One per WebSocket, so two windows can look at different projects.
 */
export class OfficeSession {
  private activeProjectId: ProjectId | undefined;
  /** Which agent's configuration this window has open. Per-connection UI state. */
  private selectedAgentId: string | undefined;
  /** Which project workspace this window has open. Also per-connection. */
  private openProjectId: string | undefined;
  /** Live-run subscription, held only while this window's run is in flight. */
  private runSubscription: (() => void) | undefined;

  async handle(message: ClientMessage, send: Send): Promise<void> {
    const storage = getOfficeStorage();
    if (!storage) {
      // No database: report the failure and an empty office rather than
      // pretending the operation worked.
      send(asWire(emptyOfficeState()));
      return;
    }
    const service = new OfficeService(storage);

    try {
      switch (message.type) {
        case 'requestOffice':
          break;

        case 'createProject': {
          const project = await service.createProject({
            name: message.name,
            description: message.description,
          });
          // Creating a project selects it: the operator almost always wants to
          // work in what they just made.
          this.activeProjectId = project.id;
          break;
        }

        case 'setActiveProject':
          this.activeProjectId =
            message.projectId === undefined ? undefined : asProjectId(message.projectId);
          break;

        case 'createAgent':
          await service.createAgent({
            name: message.name,
            role: message.role,
            provider: message.provider,
            description: message.description,
            systemPrompt: message.systemPrompt,
            model: message.model,
          });
          break;

        case 'addAgentToProject':
          await service.addAgentToProject({
            projectId: message.projectId,
            agentId: message.agentId,
          });
          break;

        case 'removeAgentFromProject':
          await service.removeAgentFromProject({
            projectId: message.projectId,
            agentId: message.agentId,
          });
          break;

        case 'createTask':
          await service.createTask({
            projectId: message.projectId,
            title: message.title,
            description: message.description,
            assignedAgentId: message.assignedAgentId,
            priority: message.priority as TaskPriority | undefined,
            parentTaskId: message.parentTaskId,
            dependencies: message.dependencies,
            inputs: message.inputs?.map(toTaskInput),
          });
          break;

        // ── Agent configuration ──
        // These change one agent and never the office listing, so they answer
        // with the agent detail rather than a fresh office snapshot.

        case 'requestAgentDetail':
          this.selectedAgentId = message.agentId;
          await this.sendAgentDetail(service, send);
          return;

        case 'updateAgent': {
          const agent = await service.updateAgent({
            agentId: message.agentId,
            name: message.name,
            role: message.role,
            description: message.description,
            systemPrompt: message.systemPrompt,
            model: message.model,
          });
          this.selectedAgentId = agent.id;
          await this.sendAgentDetail(service, send);
          // The library shows names and roles, so it needs the new snapshot too.
          send(asWire(await this.buildState(service)));
          return;
        }

        case 'createSkill': {
          await service.createSkill({
            agentId: message.agentId,
            slug: message.slug,
            name: message.name,
            kind: message.kind as SkillKind,
            description: message.description,
            content: message.content,
            requiredTools: message.requiredTools,
          });
          this.selectedAgentId = message.agentId;
          await this.sendAgentDetail(service, send);
          return;
        }

        case 'updateSkill':
          // Never clear the selection on a malformed message: the reply the UI
          // needs is this agent's configuration, not silence.
          this.selectedAgentId = message.agentId || this.selectedAgentId;
          await service.updateSkill({
            agentId: message.agentId,
            skillId: message.skillId,
            slug: message.slug,
            name: message.name,
            kind: message.kind as SkillKind | undefined,
            description: message.description,
            content: message.content,
            requiredTools: message.requiredTools,
          });
          await this.sendAgentDetail(service, send);
          return;

        case 'deleteSkill':
          // Never clear the selection on a malformed message: the reply the UI
          // needs is this agent's configuration, not silence.
          this.selectedAgentId = message.agentId || this.selectedAgentId;
          await service.deleteSkill({ agentId: message.agentId, skillId: message.skillId });
          await this.sendAgentDetail(service, send);
          return;

        case 'createAgentKnowledge': {
          await service.createAgentKnowledge({
            agentId: message.agentId,
            title: message.title,
            knowledgeType: message.knowledgeType as KnowledgeType,
            content: message.content,
            tags: message.tags,
          });
          this.selectedAgentId = message.agentId;
          await this.sendAgentDetail(service, send);
          return;
        }

        case 'updateAgentKnowledge':
          // Never clear the selection on a malformed message: the reply the UI
          // needs is this agent's configuration, not silence.
          this.selectedAgentId = message.agentId || this.selectedAgentId;
          await service.updateAgentKnowledge({
            agentId: message.agentId,
            knowledgeId: message.knowledgeId,
            title: message.title,
            knowledgeType: message.knowledgeType as KnowledgeType | undefined,
            content: message.content,
            tags: message.tags,
          });
          await this.sendAgentDetail(service, send);
          return;

        case 'deleteAgentKnowledge':
          // Never clear the selection on a malformed message: the reply the UI
          // needs is this agent's configuration, not silence.
          this.selectedAgentId = message.agentId || this.selectedAgentId;
          await service.deleteAgentKnowledge({
            agentId: message.agentId,
            knowledgeId: message.knowledgeId,
          });
          await this.sendAgentDetail(service, send);
          return;

        // ── Project workspace ──
        // These change one project and answer with its workspace. Tasks and
        // memberships also appear in the office snapshot, so both are sent.

        case 'requestProjectDetail':
          this.openProjectId = message.projectId;
          await this.sendProjectDetail(service, send);
          return;

        case 'updateProject': {
          const project = await service.updateProject({
            projectId: message.projectId,
            name: message.name,
            description: message.description,
            status: message.status as ProjectStatus | undefined,
            workspacePaths: message.workspacePaths,
            defaultProvider: message.defaultProvider,
            defaultModel: message.defaultModel,
          });
          // The workspace and the project list both change, and both are sent
          // by the shared tail below.
          this.openProjectId = project.id;
          break;
        }

        case 'createProjectKnowledge':
          await service.createProjectKnowledge({
            projectId: message.projectId,
            title: message.title,
            knowledgeType: message.knowledgeType as KnowledgeType,
            content: message.content,
            tags: message.tags,
          });
          this.openProjectId = message.projectId;
          await this.sendProjectDetail(service, send);
          return;

        case 'updateProjectKnowledge':
          await service.updateProjectKnowledge({
            knowledgeId: message.knowledgeId,
            title: message.title,
            knowledgeType: message.knowledgeType as KnowledgeType | undefined,
            content: message.content,
            tags: message.tags,
          });
          await this.sendProjectDetail(service, send);
          return;

        case 'deleteProjectKnowledge':
          await service.deleteProjectKnowledge(message.knowledgeId);
          await this.sendProjectDetail(service, send);
          return;

        case 'updateTask':
          await service.updateTask({
            taskId: message.taskId,
            title: message.title,
            description: message.description,
            priority: message.priority as TaskPriority | undefined,
            parentTaskId: message.parentTaskId,
            clearParentTask: message.clearParentTask,
            dependencies: message.dependencies,
            inputs: message.inputs?.map(toTaskInput),
          });
          break;

        case 'assignTask':
          await service.assignTask({ taskId: message.taskId, agentId: message.agentId });
          break;

        case 'unassignTask':
          await service.unassignTask(message.taskId);
          break;

        case 'setTaskStatus':
          await service.setTaskStatus({
            taskId: message.taskId,
            status: message.status as TaskStatus,
          });
          break;

        case 'deleteTask':
          await service.deleteTask(message.taskId);
          break;

        // ── Execution ──
        // The Office asks a runtime to run one task. Upstream's hook events
        // stay observational; this is the separate downward channel (ADR 003).

        case 'runTask': {
          const runner = getTaskRunner(storage);
          this.watchRun(runner, service, send);
          await runner.run(message.taskId, this.activeProjectId);
          break;
        }

        case 'acceptTask':
          // The human half of the cycle. No runtime is involved.
          await service.acceptTask(message.taskId);
          break;

        case 'requestTaskChanges': {
          const runner = getTaskRunner(storage);
          this.watchRun(runner, service, send);
          await runner.revise(message.taskId, message.feedback, this.activeProjectId);
          break;
        }

        case 'cancelTaskRun':
          await getTaskRunner(storage).cancel();
          return;

        case 'requestOutputContent': {
          const resolved = await service.outputContent(message.outputId);
          send(
            asWire({
              type: 'outputContent',
              outputId: message.outputId,
              readable: resolved?.contentReadable ?? false,
              ...(resolved ? { title: resolved.output.title } : {}),
              ...(resolved?.content === undefined ? {} : { content: resolved.content }),
            }),
          );
          return;
        }

        default:
          return;
      }
    } catch (error) {
      send(
        asWire({
          type: 'officeError',
          operation: message.type,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      // Still send the true state after a rejected operation, so the UI never
      // keeps whatever it optimistically assumed.
      if (isAgentConfigMessage(message.type)) {
        await this.sendAgentDetail(service, send);
        return;
      }
    }

    // Task and membership changes move the office snapshot as well as the
    // workspace, so both are refreshed.
    if (isProjectWorkspaceMessage(message.type)) {
      await this.sendProjectDetail(service, send);
    }
    send(asWire(await this.buildState(service)));
  }

  /** The snapshot a freshly connected client gets during the ready handshake. */
  async initialState(): Promise<Record<string, unknown>> {
    const storage = getOfficeStorage();
    if (!storage) {
      return asWire(emptyOfficeState());
    }
    return asWire(await this.buildState(new OfficeService(storage)));
  }

  /** Push the selected agent's configuration, if one is selected and still exists. */
  private async sendAgentDetail(service: OfficeService, send: Send): Promise<void> {
    if (!this.selectedAgentId) {
      return;
    }
    const detail = await service.agentDetail(this.selectedAgentId);
    if (!detail) {
      this.selectedAgentId = undefined;
      return;
    }
    send(
      asWire({
        type: 'agentDetail',
        agent: toOfficeAgent(detail.agent),
        skills: detail.skills.map(toOfficeSkill),
        knowledge: detail.knowledge.map(toOfficeAgentKnowledge),
        fileBacked: detail.fileBacked,
        ...(detail.configIssue === undefined ? {} : { configIssue: detail.configIssue }),
      }),
    );
  }

  /** Push the open project's workspace, if one is open and still exists. */
  private async sendProjectDetail(service: OfficeService, send: Send): Promise<void> {
    if (!this.openProjectId) {
      return;
    }
    const detail = await service.projectDetail(this.openProjectId);
    if (!detail) {
      this.openProjectId = undefined;
      return;
    }
    send(
      asWire({
        type: 'projectDetail',
        project: toOfficeProjectDetail(detail.project),
        memberships: detail.memberships.map(toOfficeMembership),
        knowledge: detail.knowledge.map(toOfficeProjectKnowledge),
        tasks: detail.tasks.map(toOfficeTask),
        sessions: detail.sessions.map(toOfficeSession),
        outputs: detail.outputs.map(toOfficeOutput),
        reviewNotes: detail.reviewNotes.map(toOfficeReviewNote),
      }),
    );
  }

  /**
   * Follow the live run until it ends.
   *
   * A run outlives the message that started it, so the workspace is re-sent on
   * every state change rather than left to the client to poll. The subscription
   * is dropped the moment the run reaches a terminal state, so nothing survives
   * the run; a send into a closed socket is caught here for the same reason.
   */
  private watchRun(
    runner: ReturnType<typeof getTaskRunner>,
    service: OfficeService,
    send: Send,
  ): void {
    this.runSubscription?.();
    const onChange = (change: RunChange): void => {
      void this.sendProjectDetail(service, send)
        .then(() => {
          if (change.session.status === 'ended' || change.session.status === 'failed') {
            this.runSubscription?.();
            this.runSubscription = undefined;
          }
        })
        .catch(() => {
          // The window is gone. Stop following the run; the run itself is
          // unaffected and its result is already persisted.
          this.runSubscription?.();
          this.runSubscription = undefined;
        });
    };
    runner.on('change', onChange);
    this.runSubscription = () => runner.off('change', onChange);
  }

  private async buildState(service: OfficeService): Promise<OfficeState> {
    const snapshot = await service.snapshot(this.activeProjectId);
    // A project that was deleted elsewhere must not stay selected.
    this.activeProjectId = snapshot.activeProjectId;
    return {
      type: 'officeState',
      storage: officeStorageStatus(),
      projects: snapshot.projects.map(toOfficeProject),
      agents: snapshot.agents.map(toOfficeAgent),
      memberships: snapshot.memberships.map(toOfficeMembership),
      tasks: snapshot.tasks.map(toOfficeTask),
      ...(snapshot.activeProjectId ? { activeProjectId: snapshot.activeProjectId } : {}),
    };
  }
}

function emptyOfficeState(): OfficeState {
  return {
    type: 'officeState',
    storage: officeStorageStatus(),
    projects: [],
    agents: [],
    memberships: [],
    tasks: [],
  };
}

// ── Domain -> wire ───────────────────────────────────────────────
// Deliberately explicit rather than spread: the wire shape is a contract, and
// a field added to the domain should not leak onto it by accident.

function toOfficeProject(project: Project): OfficeState['projects'][number] {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toOfficeAgent(agent: AgentDefinition): OfficeState['agents'][number] {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    provider: agent.provider,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function toOfficeMembership(membership: ProjectAgent): OfficeState['memberships'][number] {
  return {
    id: membership.id,
    projectId: membership.projectId,
    agentId: membership.agentId,
    ...(membership.seatId ? { seatId: membership.seatId } : {}),
  };
}

function toOfficeTask(task: Task): OfficeState['tasks'][number] {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    ...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    dependencies: task.dependencies,
    inputs: task.inputs.map(toOfficeTaskInput),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** Agent-configuration messages answer with agentDetail, not an office snapshot. */
const AGENT_CONFIG_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'requestAgentDetail',
  'updateAgent',
  'createSkill',
  'updateSkill',
  'deleteSkill',
  'createAgentKnowledge',
  'updateAgentKnowledge',
  'deleteAgentKnowledge',
]);

function isAgentConfigMessage(type: string): boolean {
  return AGENT_CONFIG_MESSAGE_TYPES.has(type);
}

function toOfficeSkill(skill: Skill): AgentDetail['skills'][number] {
  return {
    id: skill.id,
    agentId: skill.agentId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    kind: skill.kind,
    requiredTools: skill.requiredTools,
    // Only an inline `content` source has a body to edit; an MCP or integration
    // source is configuration, not text, so it carries none.
    ...(skill.source.origin === 'content' && skill.source.ref.store === 'inline'
      ? { content: skill.source.ref.content }
      : {}),
  };
}

function toOfficeAgentKnowledge(view: AgentKnowledgeView): AgentDetail['knowledge'][number] {
  return {
    id: view.item.id,
    agentId: view.item.agentId,
    type: view.item.type,
    title: view.item.title,
    tags: view.item.tags,
    contentReadable: view.contentReadable,
    ...(view.content === undefined ? {} : { content: view.content }),
    createdAt: view.item.createdAt,
    updatedAt: view.item.updatedAt,
  };
}

/**
 * Messages the open workspace must be re-derived for.
 *
 * The knowledge ones answer with the workspace alone and return before the
 * shared tail, so they appear here only for the error path — a rejected edit
 * still has to leave the client showing what is really stored.
 */
const PROJECT_WORKSPACE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'updateProject',
  'createProjectKnowledge',
  'updateProjectKnowledge',
  'deleteProjectKnowledge',
  'createTask',
  'updateTask',
  'assignTask',
  'unassignTask',
  'setTaskStatus',
  'deleteTask',
  'runTask',
  'acceptTask',
  'requestTaskChanges',
  'addAgentToProject',
  'removeAgentFromProject',
]);

function isProjectWorkspaceMessage(type: string): boolean {
  return PROJECT_WORKSPACE_MESSAGE_TYPES.has(type);
}

function toOfficeProjectDetail(project: Project): ProjectDetail['project'] {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    workspacePaths: project.settings.workspacePaths,
    ...(project.settings.defaultProvider === undefined
      ? {}
      : { defaultProvider: project.settings.defaultProvider }),
    ...(project.settings.defaultModel === undefined
      ? {}
      : { defaultModel: project.settings.defaultModel }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toOfficeProjectKnowledge(view: ProjectKnowledgeView): ProjectDetail['knowledge'][number] {
  return {
    id: view.item.id,
    projectId: view.item.projectId,
    type: view.item.type,
    title: view.item.title,
    tags: view.item.tags,
    contentReadable: view.contentReadable,
    ...(view.content === undefined ? {} : { content: view.content }),
    createdAt: view.item.createdAt,
    updatedAt: view.item.updatedAt,
  };
}

/**
 * TaskInput is a discriminated union in the domain and a flat record on the
 * wire, because a oneOf of nested objects is not something the generator models
 * usefully. These two functions are the whole of the difference.
 */
function toOfficeTaskInput(input: TaskInput): OfficeTaskInput {
  switch (input.kind) {
    case 'text':
      return { kind: 'text', value: input.value };
    case 'projectKnowledge':
      return { kind: 'projectKnowledge', knowledgeId: input.knowledgeId };
    case 'output':
      return { kind: 'output', outputId: input.outputId };
    case 'file':
      return { kind: 'file', path: input.path };
  }
}

function toTaskInput(input: OfficeTaskInput): TaskInput {
  switch (input.kind) {
    case 'text':
      return { kind: 'text', value: input.value ?? '' };
    case 'projectKnowledge':
      // Project knowledge only: an agent's own knowledge is never a task input.
      return {
        kind: 'projectKnowledge',
        knowledgeId: asProjectKnowledgeId(requireField(input.knowledgeId, 'knowledgeId')),
      };
    case 'output':
      return { kind: 'output', outputId: asOutputId(requireField(input.outputId, 'outputId')) };
    case 'file':
      return { kind: 'file', path: requireField(input.path, 'path') };
    default:
      throw new Error(`unknown task input kind: ${input.kind}`);
  }
}

function requireField(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`task input is missing ${name}`);
  }
  return value;
}

function toOfficeSession(session: AgentSession): ProjectDetail['sessions'][number] {
  return {
    id: session.id,
    agentId: session.agentId,
    projectId: session.projectId,
    ...(session.taskId ? { taskId: session.taskId } : {}),
    provider: session.provider,
    status: session.status,
    startedAt: session.startedAt,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
  };
}

function toOfficeOutput(output: OutputItem): ProjectDetail['outputs'][number] {
  return {
    id: output.id,
    projectId: output.projectId,
    taskId: output.taskId,
    producedByAgentId: output.producedByAgentId,
    ...(output.sessionId ? { sessionId: output.sessionId } : {}),
    title: output.title,
    type: output.type,
    createdAt: output.createdAt,
  };
}

function toOfficeReviewNote(note: ReviewNote): ProjectDetail['reviewNotes'][number] {
  return {
    id: note.id,
    taskId: note.taskId,
    ...(note.aboutSessionId ? { aboutSessionId: note.aboutSessionId } : {}),
    ...(note.triggeredSessionId ? { triggeredSessionId: note.triggeredSessionId } : {}),
    author: note.author,
    body: note.body,
    createdAt: note.createdAt,
  };
}

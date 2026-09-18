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
  ServerMessage,
} from '../../../core/src/messages.js';
import type {
  AgentDefinition,
  KnowledgeType,
  Project,
  ProjectAgent,
  ProjectId,
  Skill,
  SkillKind,
  Task,
} from '../../../domain/src/index.js';
import { asProjectId } from '../../../domain/src/index.js';
import type { AgentKnowledgeView } from './officeService.js';
import { OfficeService } from './officeService.js';
import { getOfficeStorage, officeStorageStatus } from './officeStorage.js';

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
          await service.updateSkill({
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
          await service.deleteSkill(message.skillId);
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
          await service.updateAgentKnowledge({
            knowledgeId: message.knowledgeId,
            title: message.title,
            knowledgeType: message.knowledgeType as KnowledgeType | undefined,
            content: message.content,
            tags: message.tags,
          });
          await this.sendAgentDetail(service, send);
          return;

        case 'deleteAgentKnowledge':
          await service.deleteAgentKnowledge(message.knowledgeId);
          await this.sendAgentDetail(service, send);
          return;

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
      }),
    );
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

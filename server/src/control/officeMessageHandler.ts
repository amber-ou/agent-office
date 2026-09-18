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

import type { ClientMessage, OfficeState, ServerMessage } from '../../../core/src/messages.js';
import type {
  AgentDefinition,
  Project,
  ProjectAgent,
  ProjectId,
  Task,
} from '../../../domain/src/index.js';
import { asProjectId } from '../../../domain/src/index.js';
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
      // Still send the snapshot: the UI should show the true state after a
      // rejected operation, not whatever it optimistically assumed.
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

/**
 * ProjectAgent — membership of one Agent in one Project.
 *
 * Agents are global (ADR 005), so "which agents work on this project" is a
 * relation, not a field on either side. This is the whole of it: the pair, plus
 * the two things that are genuinely per-project rather than per-agent.
 *
 * Deleting a membership removes the agent from that project and nothing else.
 * The AgentDefinition, its skills and its knowledge are untouched, and its
 * memberships of other projects are untouched.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { crossProjectError, validationError } from './errors.js';
import type { AgentId, ProjectAgentId, ProjectId } from './ids.js';
import { newProjectAgentId } from './ids.js';

export interface ProjectAgent {
  id: ProjectAgentId;
  projectId: ProjectId;
  agentId: AgentId;
  /**
   * Who this agent reports to WITHIN THIS PROJECT. The hierarchy is
   * project-scoped: the same agent may lead one project and report in another,
   * which is why this cannot live on the global AgentDefinition.
   */
  managerAgentId?: AgentId;
  /** Seat in this project's office layout. Per-project for the same reason. */
  seatId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateProjectAgentInput {
  projectId: ProjectId;
  agentId: AgentId;
  managerAgentId?: AgentId;
  seatId?: string | null;
}

export function createProjectAgent(input: CreateProjectAgentInput, deps: DomainDeps): ProjectAgent {
  if (input.managerAgentId === input.agentId) {
    throw validationError('an agent cannot report to itself', { agentId: input.agentId });
  }
  const now = deps.clock.now();
  return {
    id: newProjectAgentId(deps.ids),
    projectId: input.projectId,
    agentId: input.agentId,
    managerAgentId: input.managerAgentId,
    seatId: input.seatId,
    createdAt: now,
    updatedAt: now,
  };
}

export type ProjectAgentPatch = Partial<Pick<ProjectAgent, 'managerAgentId' | 'seatId'>>;

export function updateProjectAgent(
  membership: ProjectAgent,
  patch: ProjectAgentPatch,
  clock: Clock,
): ProjectAgent {
  const managerAgentId =
    'managerAgentId' in patch ? patch.managerAgentId : membership.managerAgentId;
  if (managerAgentId === membership.agentId) {
    throw validationError('an agent cannot report to itself', { agentId: membership.agentId });
  }
  return {
    ...membership,
    managerAgentId,
    seatId: 'seatId' in patch ? patch.seatId : membership.seatId,
    updatedAt: clock.now(),
  };
}

/**
 * A manager must itself be a member of the same project — otherwise the
 * hierarchy points outside the project it belongs to. Pure: the caller supplies
 * the project's memberships.
 */
export function assertManagerIsMember(
  membership: ProjectAgent,
  projectMemberships: readonly ProjectAgent[],
): void {
  if (membership.managerAgentId === undefined) {
    return;
  }
  const manager = projectMemberships.find(
    (m) => m.agentId === membership.managerAgentId && m.projectId === membership.projectId,
  );
  if (!manager) {
    throw crossProjectError('the manager must be a member of the same project', {
      projectId: membership.projectId,
      agentId: membership.agentId,
      managerAgentId: membership.managerAgentId,
    });
  }
}

/**
 * One agent joins a project once. Uniqueness is (projectId, agentId), not the
 * membership id — two rows for the same pair are the same membership recorded
 * twice.
 */
export function assertNotAlreadyMember(
  projectId: ProjectId,
  agentId: AgentId,
  existing: readonly ProjectAgent[],
): void {
  if (existing.some((m) => m.projectId === projectId && m.agentId === agentId)) {
    throw validationError('agent is already a member of this project', { projectId, agentId });
  }
}

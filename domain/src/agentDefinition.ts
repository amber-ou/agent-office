/**
 * AgentDefinition — "who this agent is".
 *
 * A persistent role that outlives every run. Creating a session, finishing a
 * task, restarting the server, losing a container: none of them delete or mutate
 * a definition.
 *
 * INVARIANT (ADR 002): no provider-specific runtime state may appear on this
 * type. No Claude session UUID, no Codex runtime id, no terminal id, no process
 * id, no hook state, and no `status` — those belong to AgentSession or are
 * derived (see agentStatus.ts). `domain/__tests__/agentDefinition.test.ts` pins
 * this at compile time, so a field added here that names runtime state fails the
 * build rather than review.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { AgentId, ProjectId, SkillId } from './ids.js';
import { newAgentId } from './ids.js';

/** How a tool is offered to this agent. Mirrors the three answers a runtime can give. */
export const ToolMode = {
  ALLOW: 'allow',
  ASK: 'ask',
  DENY: 'deny',
} as const;
export type ToolMode = (typeof ToolMode)[keyof typeof ToolMode];

export interface ToolGrant {
  /** Provider-agnostic tool name, e.g. 'Read', 'Bash', 'mcp__figma__get_file'. */
  name: string;
  mode: ToolMode;
}

export interface AgentMemoryConfig {
  /** Long-lived notes carried into every session for this agent. */
  notes: string;
  /** How many recently finished tasks to summarise into context. 0 disables it. */
  recentTaskSummaryLimit: number;
}

/**
 * Office appearance. Values mirror upstream's character palette so a character
 * keeps its look across restarts, but nothing here is runtime state — it is a
 * stable property of the role, like a name.
 */
export interface AgentAppearance {
  /** Upstream palette index (0-5). Undefined = let the office pick a diverse one. */
  palette?: number;
  /** Hue rotation in degrees (0-360), applied on top of the palette. */
  hueShift?: number;
  /** Preferred seat uid in the office layout. */
  seatId?: string | null;
}

export interface AgentDefinition {
  id: AgentId;
  projectId: ProjectId;
  /** Display name, e.g. "UX Agent". */
  name: string;
  /** Stable key within the project, e.g. "ux". Unique per project. */
  role: string;
  description: string;
  systemPrompt: string;
  /** Provider id, e.g. 'claude'. Never hard-coded downstream. */
  provider: string;
  /** Model id. Undefined falls back to the project's defaultModel. */
  model?: string;
  /** Skills are referenced, never embedded (ADR 001 / requirement 9). */
  skillIds: SkillId[];
  tools: ToolGrant[];
  /** The agent this one reports to. Data only until Milestone 8. */
  managerAgentId?: AgentId;
  memory: AgentMemoryConfig;
  appearance: AgentAppearance;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateAgentDefinitionInput {
  projectId: ProjectId;
  name: string;
  role: string;
  description?: string;
  systemPrompt?: string;
  provider: string;
  model?: string;
  skillIds?: SkillId[];
  tools?: ToolGrant[];
  managerAgentId?: AgentId;
  memory?: Partial<AgentMemoryConfig>;
  appearance?: AgentAppearance;
}

export function defaultAgentMemoryConfig(): AgentMemoryConfig {
  return { notes: '', recentTaskSummaryLimit: 5 };
}

/** Normalise a role key: lower-case, spaces and underscores to hyphens. */
export function normalizeRole(role: string): string {
  return requireText('agent.role', role)
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export function createAgentDefinition(
  input: CreateAgentDefinitionInput,
  deps: DomainDeps,
): AgentDefinition {
  const now = deps.clock.now();
  return {
    id: newAgentId(deps.ids),
    projectId: input.projectId,
    name: requireText('agent.name', input.name),
    role: normalizeRole(input.role),
    description: input.description?.trim() ?? '',
    systemPrompt: input.systemPrompt ?? '',
    provider: requireText('agent.provider', input.provider),
    model: input.model,
    skillIds: [...(input.skillIds ?? [])],
    tools: [...(input.tools ?? [])],
    managerAgentId: input.managerAgentId,
    memory: { ...defaultAgentMemoryConfig(), ...input.memory },
    appearance: { ...input.appearance },
    createdAt: now,
    updatedAt: now,
  };
}

export type AgentDefinitionPatch = Partial<
  Pick<
    AgentDefinition,
    | 'name'
    | 'description'
    | 'systemPrompt'
    | 'model'
    | 'skillIds'
    | 'tools'
    | 'managerAgentId'
    | 'appearance'
  > & { role: string; memory: Partial<AgentMemoryConfig> }
>;

export function updateAgentDefinition(
  agent: AgentDefinition,
  patch: AgentDefinitionPatch,
  clock: Clock,
): AgentDefinition {
  return {
    ...agent,
    name: patch.name === undefined ? agent.name : requireText('agent.name', patch.name),
    role: patch.role === undefined ? agent.role : normalizeRole(patch.role),
    description: patch.description ?? agent.description,
    systemPrompt: patch.systemPrompt ?? agent.systemPrompt,
    model: 'model' in patch ? patch.model : agent.model,
    skillIds: patch.skillIds ? [...patch.skillIds] : agent.skillIds,
    tools: patch.tools ? [...patch.tools] : agent.tools,
    managerAgentId: 'managerAgentId' in patch ? patch.managerAgentId : agent.managerAgentId,
    memory: patch.memory ? { ...agent.memory, ...patch.memory } : agent.memory,
    appearance: patch.appearance ? { ...agent.appearance, ...patch.appearance } : agent.appearance,
    updatedAt: clock.now(),
  };
}

// ── Skill assignment (references only) ───────────────────────────

export function assignSkill(
  agent: AgentDefinition,
  skillId: SkillId,
  clock: Clock,
): AgentDefinition {
  if (agent.skillIds.includes(skillId)) {
    return agent;
  }
  return { ...agent, skillIds: [...agent.skillIds, skillId], updatedAt: clock.now() };
}

export function unassignSkill(
  agent: AgentDefinition,
  skillId: SkillId,
  clock: Clock,
): AgentDefinition {
  if (!agent.skillIds.includes(skillId)) {
    return agent;
  }
  return {
    ...agent,
    skillIds: agent.skillIds.filter((id) => id !== skillId),
    updatedAt: clock.now(),
  };
}

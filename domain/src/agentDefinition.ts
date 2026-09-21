/**
 * AgentDefinition — "who this agent is".
 *
 * A GLOBAL, reusable specialist owned by Agent Office itself, not by any
 * Project. The same agent may be a member of many Projects at once; membership
 * is `ProjectAgent` (ADR 005). Nothing here is project-scoped.
 *
 * An agent independently owns its own instructions, skills, knowledge and tool
 * configuration. Those are what make it a specialist, and they are its
 * permanent property: working on a Project never mutates them.
 *
 * INVARIANT (ADR 002): no provider-specific runtime state may appear on this
 * type. No Claude session UUID, no Codex runtime id, no terminal id, no process
 * id, no hook state, and no `status` — those belong to AgentSession or are
 * derived (see agentStatus.ts).
 *
 * INVARIANT (ADR 005): no project-scoped field may appear here either. No
 * `projectId`, no `taskId`, no seat. `domain/__tests__/agentDefinition.test.ts`
 * pins both at compile time, so a field added here that names runtime state or
 * a project fails the build rather than review.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { AgentId } from './ids.js';
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

/**
 * The agent's own long-lived memory.
 *
 * Deliberately NOT a place where project work accumulates. Project content,
 * tasks, outputs and project knowledge never flow in here automatically; a
 * write to this field is an explicit, deliberate act (ADR 005).
 */
export interface AgentMemoryConfig {
  /** Long-lived notes carried into every session for this agent. */
  notes: string;
  /** How many recently finished tasks to summarise into context. 0 disables it. */
  recentTaskSummaryLimit: number;
}

/**
 * Office appearance that belongs to the agent wherever it works — its look, not
 * its location. The seat is per-project and lives on `ProjectAgent`.
 */
export interface AgentAppearance {
  /** Upstream palette index (0-5). Undefined = let the office pick a diverse one. */
  palette?: number;
  /** Hue rotation in degrees (0-360), applied on top of the palette. */
  hueShift?: number;
}

export interface AgentDefinition {
  id: AgentId;
  /** Display name, chosen by the operator. */
  name: string;
  /** Stable key for this specialist, e.g. "ux". Agent Office does not enforce
   *  uniqueness — two differently-configured agents may share a role. */
  role: string;
  description: string;
  /** The agent's own instructions. Owned by the agent, never by a project. */
  systemPrompt: string;
  /** Provider id, e.g. 'claude'. Never hard-coded downstream. */
  provider: string;
  /** Model id. Undefined falls back to the project's defaultModel at dispatch. */
  model?: string;
  tools: ToolGrant[];
  memory: AgentMemoryConfig;
  appearance: AgentAppearance;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateAgentDefinitionInput {
  name: string;
  role: string;
  description?: string;
  systemPrompt?: string;
  provider: string;
  model?: string;
  tools?: ToolGrant[];
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
    name: requireText('agent.name', input.name),
    role: normalizeRole(input.role),
    description: input.description?.trim() ?? '',
    systemPrompt: input.systemPrompt ?? '',
    provider: requireText('agent.provider', input.provider),
    model: input.model,
    tools: [...(input.tools ?? [])],
    memory: { ...defaultAgentMemoryConfig(), ...input.memory },
    appearance: { ...input.appearance },
    createdAt: now,
    updatedAt: now,
  };
}

export type AgentDefinitionPatch = Partial<
  Pick<
    AgentDefinition,
    'name' | 'description' | 'systemPrompt' | 'model' | 'tools' | 'appearance'
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
    tools: patch.tools ? [...patch.tools] : agent.tools,
    memory: patch.memory ? { ...agent.memory, ...patch.memory } : agent.memory,
    appearance: patch.appearance ? { ...agent.appearance, ...patch.appearance } : agent.appearance,
    updatedAt: clock.now(),
  };
}

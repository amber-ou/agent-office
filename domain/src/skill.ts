/**
 * Skill — a capability owned by ONE Agent.
 *
 * There is no global Skill Library, and skills are not shared between agents
 * (ADR 005). A skill belongs to the agent that owns it, the same way its
 * instructions do: two agents that both know how to do user research each own
 * their own version of that skill, configured their own way.
 *
 * Ownership points from the skill to the agent (`Skill.agentId`), so there is
 * exactly one source of truth. `AgentDefinition` carries no skill list — a
 * denormalised second copy could disagree with this one.
 *
 * A Skill is deliberately NOT a prompt string. `kind` says what sort of
 * capability it is; `source` says where its content lives. They are orthogonal:
 * a workflow may be inline markdown today and an MCP capability tomorrow
 * without the agent that owns it changing at all.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { AgentId, SkillId } from './ids.js';
import { newSkillId } from './ids.js';
import type { ResourceRef } from './resource.js';

export const SkillKind = {
  /** Prompt-level guidance folded into the agent's instructions. */
  INSTRUCTION: 'instruction',
  /** A multi-step procedure the agent is expected to follow. */
  WORKFLOW: 'workflow',
  /** A named set of tools this capability implies. */
  TOOL_BUNDLE: 'tool_bundle',
  /** A capability provided by an MCP server. */
  MCP_CAPABILITY: 'mcp_capability',
  /** An executable the runtime invokes. */
  SCRIPT: 'script',
  /** Anything reached through a third-party integration. */
  EXTERNAL: 'external',
} as const;
export type SkillKind = (typeof SkillKind)[keyof typeof SkillKind];

export type SkillSource =
  /** Content carried in the record itself, or pointed at by a ResourceRef. */
  | { origin: 'content'; ref: ResourceRef }
  /** Provided by an MCP server; `tool` narrows it to one capability. */
  | { origin: 'mcp'; server: string; tool?: string }
  /** Provided by a named third-party integration. */
  | { origin: 'integration'; integration: string; config: Readonly<Record<string, string>> };

export interface Skill {
  id: SkillId;
  /** The agent that owns this skill. Never null, never a project. */
  agentId: AgentId;
  /** Stable reference key within the owning agent, e.g. 'user-research'. */
  slug: string;
  name: string;
  description: string;
  kind: SkillKind;
  source: SkillSource;
  /** Tool names this skill cannot work without. */
  requiredTools: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateSkillInput {
  agentId: AgentId;
  slug: string;
  name: string;
  description?: string;
  kind: SkillKind;
  source: SkillSource;
  requiredTools?: string[];
}

/** Normalise a slug: lower-case, spaces and underscores to hyphens. */
export function normalizeSlug(slug: string): string {
  return requireText('skill.slug', slug)
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export function createSkill(input: CreateSkillInput, deps: DomainDeps): Skill {
  const now = deps.clock.now();
  return {
    id: newSkillId(deps.ids),
    agentId: input.agentId,
    slug: normalizeSlug(input.slug),
    name: requireText('skill.name', input.name),
    description: input.description?.trim() ?? '',
    kind: input.kind,
    source: input.source,
    requiredTools: [...(input.requiredTools ?? [])],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The owning agent is not patchable. Moving a skill between agents is not an
 * edit — it is copying one agent's capability onto another, which the product
 * model deliberately does not do implicitly.
 */
export type SkillPatch = Partial<
  Pick<Skill, 'name' | 'description' | 'kind' | 'source' | 'requiredTools'> & { slug: string }
>;

export function updateSkill(skill: Skill, patch: SkillPatch, clock: Clock): Skill {
  return {
    ...skill,
    slug: patch.slug === undefined ? skill.slug : normalizeSlug(patch.slug),
    name: patch.name === undefined ? skill.name : requireText('skill.name', patch.name),
    description: patch.description ?? skill.description,
    kind: patch.kind ?? skill.kind,
    source: patch.source ?? skill.source,
    requiredTools: patch.requiredTools ? [...patch.requiredTools] : skill.requiredTools,
    updatedAt: clock.now(),
  };
}

/** Does this skill belong to the given agent? */
export function isSkillOwnedBy(skill: Skill, agentId: AgentId): boolean {
  return skill.agentId === agentId;
}

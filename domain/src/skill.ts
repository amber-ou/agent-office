/**
 * Skill — a reusable capability definition.
 *
 * Skills are defined once and referenced by many agents (`AgentDefinition.skillIds`).
 * An agent never embeds a Skill object (requirement 9).
 *
 * A Skill is deliberately NOT a prompt string. `kind` says what sort of
 * capability it is; `source` says where its content lives. They are orthogonal:
 * a workflow may be inline markdown today and an MCP capability tomorrow without
 * the agent that references it changing at all.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { ProjectId, SkillId } from './ids.js';
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
  /**
   * null = global skill, available to every project.
   * Set = private to that project.
   */
  projectId: ProjectId | null;
  /** Stable reference key, e.g. 'ux-research'. Unique within its scope. */
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
  projectId: ProjectId | null;
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
    projectId: input.projectId,
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

/** Is this skill usable by the given project? Global skills always are. */
export function isSkillAvailableTo(skill: Skill, projectId: ProjectId): boolean {
  return skill.projectId === null || skill.projectId === projectId;
}

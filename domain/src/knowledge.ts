/**
 * Knowledge, in two kinds that must never be confused (ADR 005).
 *
 *   AgentKnowledge    permanent specialist knowledge owned by ONE Agent.
 *                     Travels with the agent into every project.
 *   ProjectKnowledge  project-specific knowledge owned by ONE Project.
 *                     Temporary; scoped to that work context.
 *
 * They are separate types with separate id brands, not one type with an owner
 * field, because the rule they enforce is absolute: project content, tasks,
 * outputs and project knowledge must NEVER become agent knowledge or permanent
 * agent memory. Working on a project must not mutate what the agent
 * permanently knows.
 *
 * Distinct brands make that a compile error rather than a review comment: there
 * is no function here that takes a ProjectKnowledge and returns an
 * AgentKnowledge, and `ProjectKnowledgeId` cannot be passed where an
 * `AgentKnowledgeId` is expected. Both are assembled side by side into runtime
 * context (see context.ts) and neither is written back into the other.
 *
 * Milestone 1 builds metadata only: no embeddings, no vector store, no
 * chunking, no retrieval. `source` is provenance ("who produced this");
 * `location` is where the bytes are.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { AgentId, AgentKnowledgeId, ProjectId, ProjectKnowledgeId, TaskId } from './ids.js';
import { newAgentKnowledgeId, newProjectKnowledgeId } from './ids.js';
import type { Metadata, ResourceRef } from './resource.js';

export const KnowledgeType = {
  MARKDOWN: 'markdown',
  PRODUCT_REQUIREMENTS: 'product_requirements',
  UX_RESEARCH: 'ux_research',
  USER_FLOW: 'user_flow',
  DESIGN_SYSTEM: 'design_system',
  UI_SPECIFICATION: 'ui_specification',
  API_DOCUMENTATION: 'api_documentation',
  UPLOAD: 'upload',
  OTHER: 'other',
} as const;
export type KnowledgeType = (typeof KnowledgeType)[keyof typeof KnowledgeType];

/**
 * Where a knowledge item came from.
 *
 * `agent` origin on AgentKnowledge means the agent deliberately recorded
 * something it permanently knows — an explicit act. It is NEVER a side effect
 * of running a task; nothing in the domain produces one.
 */
export type KnowledgeSource =
  | { origin: 'human' }
  | { origin: 'agent'; agentId: AgentId; taskId?: TaskId }
  | { origin: 'import'; system: string };

/** Fields both kinds share. Not an entity on its own — neither kind is stored
 *  as "knowledge with an owner attached". */
interface KnowledgeFields {
  type: KnowledgeType;
  title: string;
  source: KnowledgeSource;
  location: ResourceRef;
  tags: string[];
  metadata: Metadata;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Permanent knowledge owned by an Agent. Survives every project it works on. */
export interface AgentKnowledge extends KnowledgeFields {
  id: AgentKnowledgeId;
  agentId: AgentId;
}

/** Knowledge owned by a Project. Scoped to that work context. */
export interface ProjectKnowledge extends KnowledgeFields {
  id: ProjectKnowledgeId;
  projectId: ProjectId;
}

interface CreateKnowledgeFields {
  type: KnowledgeType;
  title: string;
  source: KnowledgeSource;
  location: ResourceRef;
  tags?: string[];
  metadata?: Metadata;
}

export interface CreateAgentKnowledgeInput extends CreateKnowledgeFields {
  agentId: AgentId;
}

export interface CreateProjectKnowledgeInput extends CreateKnowledgeFields {
  projectId: ProjectId;
}

function commonFields(input: CreateKnowledgeFields, now: Timestamp): KnowledgeFields {
  return {
    type: input.type,
    title: requireText('knowledge.title', input.title),
    source: input.source,
    location: input.location,
    tags: [...(input.tags ?? [])],
    metadata: { ...input.metadata },
    createdAt: now,
    updatedAt: now,
  };
}

export function createAgentKnowledge(
  input: CreateAgentKnowledgeInput,
  deps: DomainDeps,
): AgentKnowledge {
  return {
    id: newAgentKnowledgeId(deps.ids),
    agentId: input.agentId,
    ...commonFields(input, deps.clock.now()),
  };
}

export function createProjectKnowledge(
  input: CreateProjectKnowledgeInput,
  deps: DomainDeps,
): ProjectKnowledge {
  return {
    id: newProjectKnowledgeId(deps.ids),
    projectId: input.projectId,
    ...commonFields(input, deps.clock.now()),
  };
}

/** Owner is not patchable, for either kind. Re-homing knowledge is not an edit. */
export type KnowledgePatch = Partial<
  Pick<KnowledgeFields, 'type' | 'location' | 'tags' | 'metadata'> & { title: string }
>;

function applyPatch<T extends KnowledgeFields>(item: T, patch: KnowledgePatch, clock: Clock): T {
  return {
    ...item,
    type: patch.type ?? item.type,
    title: patch.title === undefined ? item.title : requireText('knowledge.title', patch.title),
    location: patch.location ?? item.location,
    tags: patch.tags ? [...patch.tags] : item.tags,
    metadata: patch.metadata ? { ...item.metadata, ...patch.metadata } : item.metadata,
    updatedAt: clock.now(),
  };
}

export function updateAgentKnowledge(
  item: AgentKnowledge,
  patch: KnowledgePatch,
  clock: Clock,
): AgentKnowledge {
  return applyPatch(item, patch, clock);
}

export function updateProjectKnowledge(
  item: ProjectKnowledge,
  patch: KnowledgePatch,
  clock: Clock,
): ProjectKnowledge {
  return applyPatch(item, patch, clock);
}

// There is deliberately NO promoteToAgentKnowledge(), no copyIntoAgentMemory(),
// and no function anywhere in the domain that converts one kind into the other.
// If an operator ever wants to teach an agent something it learned on a project,
// that is a new AgentKnowledge they author explicitly — not a promotion the
// system performs on its own.

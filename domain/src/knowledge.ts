/**
 * Knowledge — metadata and a reference, nothing more.
 *
 * Milestone 1 deliberately builds no retrieval machinery: no embeddings, no
 * vector store, no chunking, no semantic search. Those are decisions for the
 * retrieval system, and hard-coding any of them here would make the domain
 * depend on a storage technology (ADR 004).
 *
 * `source` is provenance ("who produced this"). `location` is where the bytes
 * are. They are separate because the same PRD can arrive from a human upload or
 * be written by a Spec Agent, and both may live in the same blob store.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { AgentId, KnowledgeId, ProjectId, TaskId } from './ids.js';
import { newKnowledgeId } from './ids.js';
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

export type KnowledgeSource =
  | { origin: 'human' }
  | { origin: 'agent'; agentId: AgentId; taskId?: TaskId }
  | { origin: 'import'; system: string };

export interface KnowledgeItem {
  id: KnowledgeId;
  projectId: ProjectId;
  type: KnowledgeType;
  title: string;
  /** Provenance. */
  source: KnowledgeSource;
  /** Where the content lives. */
  location: ResourceRef;
  tags: string[];
  /** Free-form annotations. A future retrieval system may add its own keys. */
  metadata: Metadata;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateKnowledgeInput {
  projectId: ProjectId;
  type: KnowledgeType;
  title: string;
  source: KnowledgeSource;
  location: ResourceRef;
  tags?: string[];
  metadata?: Metadata;
}

export function createKnowledgeItem(input: CreateKnowledgeInput, deps: DomainDeps): KnowledgeItem {
  const now = deps.clock.now();
  return {
    id: newKnowledgeId(deps.ids),
    projectId: input.projectId,
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

export type KnowledgePatch = Partial<
  Pick<KnowledgeItem, 'type' | 'location' | 'tags' | 'metadata'> & { title: string }
>;

export function updateKnowledgeItem(
  item: KnowledgeItem,
  patch: KnowledgePatch,
  clock: Clock,
): KnowledgeItem {
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

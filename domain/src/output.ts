/**
 * Output — what a task produced.
 *
 * An Output is the unit that makes agent-to-agent handoff possible: it is
 * referenced by `TaskInput { kind: 'output' }`, so the Spec Agent's deliverable
 * can be the UI Agent's input without either knowing about the other.
 *
 * Like Knowledge, only metadata and a reference live here; the bytes live
 * wherever `location` points.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { requireText } from './errors.js';
import type { AgentId, OutputId, ProjectId, SessionId, TaskId } from './ids.js';
import { newOutputId } from './ids.js';
import type { Metadata, ResourceRef } from './resource.js';

export const OutputType = {
  MARKDOWN: 'markdown',
  DIFF: 'diff',
  FILE: 'file',
  JSON: 'json',
  LINK: 'link',
} as const;
export type OutputType = (typeof OutputType)[keyof typeof OutputType];

export interface OutputItem {
  id: OutputId;
  projectId: ProjectId;
  taskId: TaskId;
  producedByAgentId: AgentId;
  /** The run that produced it. Absent for a human-supplied output. */
  sessionId?: SessionId;
  title: string;
  type: OutputType;
  location: ResourceRef;
  metadata: Metadata;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateOutputInput {
  projectId: ProjectId;
  taskId: TaskId;
  producedByAgentId: AgentId;
  sessionId?: SessionId;
  title: string;
  type: OutputType;
  location: ResourceRef;
  metadata?: Metadata;
}

export function createOutputItem(input: CreateOutputInput, deps: DomainDeps): OutputItem {
  const now = deps.clock.now();
  return {
    id: newOutputId(deps.ids),
    projectId: input.projectId,
    taskId: input.taskId,
    producedByAgentId: input.producedByAgentId,
    sessionId: input.sessionId,
    title: requireText('output.title', input.title),
    type: input.type,
    location: input.location,
    metadata: { ...input.metadata },
    createdAt: now,
    updatedAt: now,
  };
}

export type OutputPatch = Partial<
  Pick<OutputItem, 'type' | 'location' | 'metadata'> & { title: string }
>;

export function updateOutputItem(output: OutputItem, patch: OutputPatch, clock: Clock): OutputItem {
  return {
    ...output,
    type: patch.type ?? output.type,
    title: patch.title === undefined ? output.title : requireText('output.title', patch.title),
    location: patch.location ?? output.location,
    metadata: patch.metadata ? { ...output.metadata, ...patch.metadata } : output.metadata,
    updatedAt: clock.now(),
  };
}

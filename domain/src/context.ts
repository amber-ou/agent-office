/**
 * Agent context assembly — interfaces only in Milestone 1.
 *
 * What an agent is given when it starts work is layered, and the layering is the
 * point: without it every agent reads everything the project has, every time.
 *
 *   global instructions  +  project context  +  agent role
 *   +  relevant knowledge  +  current task
 *
 * `KnowledgeSelector` is the seam where "relevant" is decided. Milestone 1
 * defines the port and nothing else — no embeddings, no chunking, no ranking.
 * A tag/type selector and, later, a retrieval-backed one both satisfy this
 * interface without the domain changing.
 */

import type { AgentDefinition } from './agentDefinition.js';
import type { KnowledgeItem } from './knowledge.js';
import type { Project } from './project.js';
import type { Skill } from './skill.js';
import type { Task } from './task.js';

/** Hard ceilings, so "relevant" can never silently mean "all of it". */
export interface ContextBudget {
  maxKnowledgeItems: number;
  maxCharacters: number;
}

export function defaultContextBudget(): ContextBudget {
  return { maxKnowledgeItems: 12, maxCharacters: 60_000 };
}

export interface AgentContextRequest {
  project: Project;
  agent: AgentDefinition;
  task: Task;
  skills: readonly Skill[];
  budget: ContextBudget;
}

export interface AgentContextBundle {
  /** System-level instructions shared by every project. */
  globalInstructions: string;
  /** The project's own framing. */
  project: Project;
  /** Who this agent is. */
  agent: AgentDefinition;
  /** The capabilities it was granted, resolved from `agent.skillIds`. */
  skills: readonly Skill[];
  /** The subset of project knowledge selected for this task. */
  knowledge: readonly KnowledgeItem[];
  /** What it has been asked to do. */
  task: Task;
}

export interface KnowledgeSelector {
  select(
    request: AgentContextRequest,
    candidates: readonly KnowledgeItem[],
  ): Promise<readonly KnowledgeItem[]>;
}

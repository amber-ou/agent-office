/**
 * Agent context assembly — interfaces only in Milestone 1.
 *
 * What an agent is given when it starts work is composed at runtime from five
 * layers, and the layering is the point: without it every agent reads
 * everything, every time.
 *
 *   Agent Instructions
 * + Agent Skills
 * + Relevant Agent Knowledge     (permanent, owned by the agent)
 * + Relevant Project Knowledge   (temporary, owned by the project)
 * + Current Task Context
 *
 * COMPOSITION ONLY. The bundle is built, handed to a runtime, and discarded.
 * Nothing in it is ever written back: project context, task content and project
 * knowledge never become agent knowledge or permanent agent memory (ADR 005).
 * That is why the two knowledge kinds arrive here as two separate fields of two
 * separate types rather than one merged list — merging them is the first step
 * towards losing track of which is which.
 *
 * `KnowledgeSelector` is the seam where "relevant" is decided. Milestone 1
 * defines the port and nothing else — no embeddings, no chunking, no ranking.
 */

import type { AgentDefinition } from './agentDefinition.js';
import type { AgentKnowledge, ProjectKnowledge } from './knowledge.js';
import type { Project } from './project.js';
import type { Skill } from './skill.js';
import type { Task } from './task.js';

/** Hard ceilings, so "relevant" can never silently mean "all of it". */
export interface ContextBudget {
  maxAgentKnowledgeItems: number;
  maxProjectKnowledgeItems: number;
  maxCharacters: number;
}

export function defaultContextBudget(): ContextBudget {
  return { maxAgentKnowledgeItems: 8, maxProjectKnowledgeItems: 12, maxCharacters: 60_000 };
}

export interface AgentContextRequest {
  agent: AgentDefinition;
  /** The agent's own skills. */
  skills: readonly Skill[];
  project: Project;
  task: Task;
  budget: ContextBudget;
}

export interface AgentContextBundle {
  /** System-level instructions shared by every agent and project. */
  globalInstructions: string;
  /** Who this agent is, including its own systemPrompt. */
  agent: AgentDefinition;
  /** The capabilities it owns. */
  skills: readonly Skill[];
  /** Permanent, agent-owned. Read into context; never written back to. */
  agentKnowledge: readonly AgentKnowledge[];
  /** The project this run happens in. */
  project: Project;
  /** Project-owned. Read into context; never promoted into the agent. */
  projectKnowledge: readonly ProjectKnowledge[];
  /** What it has been asked to do. */
  task: Task;
}

/**
 * Two selections, deliberately not one. A single `select(candidates)` over a
 * merged list would need the two kinds to share a type, which is exactly what
 * ADR 005 forbids.
 */
export interface KnowledgeSelector {
  selectAgentKnowledge(
    request: AgentContextRequest,
    candidates: readonly AgentKnowledge[],
  ): Promise<readonly AgentKnowledge[]>;

  selectProjectKnowledge(
    request: AgentContextRequest,
    candidates: readonly ProjectKnowledge[],
  ): Promise<readonly ProjectKnowledge[]>;
}

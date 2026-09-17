/**
 * ProjectAggregate — a READ MODEL.
 *
 * It exists because a UI sometimes wants a project and its contents in one
 * shape. It is never persisted, never the unit of a write, and never the thing a
 * repository returns from `put`. Composing it is a query service's job; each
 * collection is fetched from its own repository and may be a partial page.
 *
 * It lives in its own module so `project.ts` does not have to import every other
 * entity module just to declare a view of them (ADR 001).
 */

import type { AgentDefinition } from './agentDefinition.js';
import type { AgentSession } from './agentSession.js';
import type { KnowledgeItem } from './knowledge.js';
import type { OutputItem } from './output.js';
import type { Project } from './project.js';
import type { Task } from './task.js';

export interface ProjectAggregate {
  project: Project;
  agents: readonly AgentDefinition[];
  sessions: readonly AgentSession[];
  tasks: readonly Task[];
  knowledge: readonly KnowledgeItem[];
  outputs: readonly OutputItem[];
}

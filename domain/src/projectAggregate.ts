/**
 * ProjectAggregate — a READ MODEL.
 *
 * It exists because a UI sometimes wants a project and its contents in one
 * shape. It is never persisted, never the unit of a write, and never the thing a
 * repository returns from `put`. Composing it is a query service's job; each
 * collection is fetched from its own repository and may be a partial page.
 *
 * Note what it does NOT contain: agent knowledge and agent skills. Those belong
 * to global agents, not to this project (ADR 005). `agents` here is the
 * membership list plus the definitions those memberships point at — the project
 * does not own them.
 */

import type { AgentDefinition } from './agentDefinition.js';
import type { AgentSession } from './agentSession.js';
import type { ProjectKnowledge } from './knowledge.js';
import type { OutputItem } from './output.js';
import type { Project } from './project.js';
import type { ProjectAgent } from './projectAgent.js';
import type { Task } from './task.js';

export interface ProjectAggregate {
  project: Project;
  /** Memberships, not ownership. */
  memberships: readonly ProjectAgent[];
  /** The global agent definitions those memberships refer to. */
  agents: readonly AgentDefinition[];
  sessions: readonly AgentSession[];
  tasks: readonly Task[];
  /** Project-owned knowledge only. Agent knowledge is never part of a project. */
  knowledge: readonly ProjectKnowledge[];
  outputs: readonly OutputItem[];
}

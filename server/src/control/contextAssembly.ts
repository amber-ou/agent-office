/**
 * Deterministic context assembly.
 *
 * Five layers, composed in one direction only:
 *
 *   agent instructions + skills + agent knowledge   (permanent, agent-owned)
 * + project + project knowledge                     (temporary, project-owned)
 * + the task and its explicit inputs
 *
 * Nothing here writes. The bundle is built for one run and discarded; project
 * and task content never reach the agent's own records (ADR 005). The two
 * knowledge kinds stay in two fields of two types for the same reason.
 *
 * "Relevant" is decided by `explicitKnowledgeSelector`: explicit task inputs
 * first, then the rest of the same project, capped by the existing
 * `ContextBudget`. No embeddings, no ranking, no search — the same task with the
 * same data selects the same items every time.
 */

import type {
  AgentContextBundle,
  AgentContextRequest,
  AgentKnowledge,
  ContextBudget,
  KnowledgeSelector,
  ProjectKnowledge,
  Repositories,
  Task,
} from '../../../domain/src/index.js';
import { defaultContextBudget } from '../../../domain/src/index.js';
import type { AgentFileStore, AgentMigrationStore } from '../../../storage/src/index.js';

/** What every agent is told, regardless of who it is or what it is doing. */
export const GLOBAL_INSTRUCTIONS = [
  'You are running as an agent inside Agent Office, on one task.',
  'Work only on the task below. Report what you did and what you produced.',
  'Your final message is captured as the task output, so make it the deliverable.',
].join(' ');

/**
 * The deterministic selector.
 *
 * Agent knowledge: the agent's own items, oldest first, capped.
 * Project knowledge: items the task names in its inputs, in the order it names
 * them, then the project's remaining items oldest first, capped. Knowledge of
 * any OTHER project is never a candidate — it is never fetched.
 */
export const explicitKnowledgeSelector: KnowledgeSelector = {
  async selectAgentKnowledge(
    request: AgentContextRequest,
    candidates: readonly AgentKnowledge[],
  ): Promise<readonly AgentKnowledge[]> {
    return [...candidates]
      .filter((item) => item.agentId === request.agent.id)
      .sort(byCreatedAt)
      .slice(0, request.budget.maxAgentKnowledgeItems);
  },

  async selectProjectKnowledge(
    request: AgentContextRequest,
    candidates: readonly ProjectKnowledge[],
  ): Promise<readonly ProjectKnowledge[]> {
    const mine = candidates.filter((item) => item.projectId === request.project.id);
    const referenced = referencedKnowledgeIds(request.task);
    const named = referenced
      .map((id) => mine.find((item) => item.id === id))
      .filter((item): item is ProjectKnowledge => item !== undefined);
    const rest = mine.filter((item) => !referenced.includes(item.id)).sort(byCreatedAt);
    return [...named, ...rest].slice(0, request.budget.maxProjectKnowledgeItems);
  },
};

export interface AssembledContext {
  bundle: AgentContextBundle;
  /** Blob contents keyed by skill id / knowledge id, for the prompt renderer. */
  contents: Map<string, string>;
}

/** What assembly reads from. Repositories, plus the agent's own files. */
export interface ContextSources {
  repos: Repositories;
  agentFiles: AgentFileStore;
  agentMigrations: AgentMigrationStore;
}

/**
 * Build the bundle for one task, and resolve the content the prompt needs.
 *
 * Reads only: the assigned agent, its skills, its knowledge, the task's project,
 * that project's knowledge, and the task. Never another project's anything, and
 * never another agent's files — every file read is scoped to the assigned
 * agent's own directory.
 *
 * The agent's instructions, skills and foundational knowledge come from ITS
 * FILES once it is file-backed; an agent still blocked on a migration conflict
 * is read from the database, so a conflict degrades the source, not the run.
 */
export async function assembleContext(
  sources: ContextSources,
  task: Task,
  budget: ContextBudget = defaultContextBudget(),
): Promise<AssembledContext> {
  const { repos, agentFiles, agentMigrations } = sources;
  if (task.assignedAgentId === undefined) {
    throw new Error('task has no assigned agent');
  }
  const [agent, project] = await Promise.all([
    repos.agents.get(task.assignedAgentId),
    repos.projects.get(task.projectId),
  ]);
  if (!agent) {
    throw new Error(`agent not found: ${task.assignedAgentId}`);
  }
  if (!project) {
    throw new Error(`project not found: ${task.projectId}`);
  }

  // Whether this agent moved to files is recorded in the database, not in the
  // files themselves — so files that have gone missing are an error here rather
  // than a silent fall back to whatever the legacy rows still say.
  const fileBacked = await agentMigrations.isMigrated(agent.id);
  if (fileBacked && (await agentFiles.readInstructions(agent.id)) === null) {
    throw new Error(
      `agent ${agent.id} is file-backed but its files are missing; restore the agents directory from a backup before running its tasks`,
    );
  }
  const contents = new Map<string, string>();

  const [storedSkills, storedKnowledge] = fileBacked
    ? await Promise.all([agentFiles.listSkills(agent.id), agentFiles.listKnowledge(agent.id)])
    : [[], []];
  const skills = fileBacked
    ? storedSkills.map((s) => s.skill)
    : await repos.skills.listByAgent(agent.id);
  const agentCandidates = fileBacked
    ? storedKnowledge.map((k) => k.item)
    : await repos.agentKnowledge.listByAgent(agent.id);
  const projectCandidates = await repos.projectKnowledge.listByProject(project.id);

  // File-backed content is already in hand; nothing re-reads it.
  for (const stored of storedSkills) {
    contents.set(stored.skill.id, stored.content);
  }
  for (const stored of storedKnowledge) {
    contents.set(stored.item.id, stored.content);
  }

  const instructions = fileBacked ? await agentFiles.readInstructions(agent.id) : null;
  const effectiveAgent = instructions === null ? agent : { ...agent, systemPrompt: instructions };

  const request: AgentContextRequest = {
    agent: effectiveAgent,
    skills,
    project,
    task,
    budget,
  };
  const [agentKnowledge, projectKnowledge] = await Promise.all([
    explicitKnowledgeSelector.selectAgentKnowledge(request, agentCandidates),
    explicitKnowledgeSelector.selectProjectKnowledge(request, projectCandidates),
  ]);

  for (const skill of skills) {
    if (
      !contents.has(skill.id) &&
      skill.source.origin === 'content' &&
      skill.source.ref.store === 'inline'
    ) {
      contents.set(skill.id, skill.source.ref.content);
    }
  }
  for (const item of [...agentKnowledge, ...projectKnowledge]) {
    if (contents.has(item.id)) {
      continue;
    }
    try {
      contents.set(item.id, await repos.blobs.read(item.location));
    } catch {
      // An unreadable reference is a gap in the prompt, not a failed run: the
      // renderer says so in place of the content.
    }
  }

  return {
    bundle: {
      globalInstructions: GLOBAL_INSTRUCTIONS,
      agent: effectiveAgent,
      skills,
      agentKnowledge,
      project,
      projectKnowledge,
      task,
    },
    contents,
  };
}

function referencedKnowledgeIds(task: Task): string[] {
  return task.inputs
    .filter((input) => input.kind === 'projectKnowledge')
    .map((input) => (input.kind === 'projectKnowledge' ? input.knowledgeId : ''));
}

function byCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt.localeCompare(b.createdAt);
}

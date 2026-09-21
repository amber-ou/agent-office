/**
 * Task — "what this agent is asked to complete".
 *
 * Two relationships exist and they are NOT interchangeable (requirement 8):
 *
 *   parentTaskId   decomposition hierarchy — "this task is part of that one"
 *   dependencies[] execution ordering      — "this task cannot start until those finish"
 *
 * A subtask need not depend on its parent, and a dependency is usually not a
 * parent. Graph validation for both lives in taskGraph.ts.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { illegalTransitionError, requireText } from './errors.js';
import type { AgentId, OutputId, ProjectId, ProjectKnowledgeId, TaskId } from './ids.js';
import { newTaskId } from './ids.js';

export const TaskStatus = {
  BACKLOG: 'backlog',
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  BLOCKED: 'blocked',
  DONE: 'done',
  FAILED: 'failed',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskPriority = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

/**
 * What a task hands its agent. A discriminated union rather than strings so
 * agent-to-agent handoff — one agent's Output becoming the next agent's input —
 * is expressible in the type system instead of by string concatenation.
 */
export type TaskInput =
  | { kind: 'text'; value: string }
  /** Project knowledge only. A task is project-scoped work, and an agent's own
   *  permanent knowledge is contributed by the agent at context assembly — it is
   *  not something a project task reaches into (ADR 005). */
  | { kind: 'projectKnowledge'; knowledgeId: ProjectKnowledgeId }
  | { kind: 'output'; outputId: OutputId }
  | { kind: 'file'; path: string };

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  description: string;
  /** Unassigned while in backlog / todo. */
  assignedAgentId?: AgentId;
  /** Undefined = created by a human. Set = created by a Manager or peer agent. */
  createdByAgentId?: AgentId;
  /** Decomposition parent. NOT an execution dependency. */
  parentTaskId?: TaskId;
  status: TaskStatus;
  priority: TaskPriority;
  /** Execution ordering. NOT a hierarchy. */
  dependencies: TaskId[];
  inputs: TaskInput[];
  outputs: OutputId[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateTaskInput {
  projectId: ProjectId;
  title: string;
  description?: string;
  assignedAgentId?: AgentId;
  createdByAgentId?: AgentId;
  parentTaskId?: TaskId;
  status?: TaskStatus;
  priority?: TaskPriority;
  dependencies?: TaskId[];
  inputs?: TaskInput[];
}

export function createTask(input: CreateTaskInput, deps: DomainDeps): Task {
  const now = deps.clock.now();
  return {
    id: newTaskId(deps.ids),
    projectId: input.projectId,
    title: requireText('task.title', input.title),
    description: input.description?.trim() ?? '',
    assignedAgentId: input.assignedAgentId,
    createdByAgentId: input.createdByAgentId,
    parentTaskId: input.parentTaskId,
    status: input.status ?? TaskStatus.BACKLOG,
    priority: input.priority ?? TaskPriority.NORMAL,
    dependencies: [...(input.dependencies ?? [])],
    inputs: [...(input.inputs ?? [])],
    outputs: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TaskStatus.BACKLOG]: [TaskStatus.TODO, TaskStatus.FAILED],
  [TaskStatus.TODO]: [TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED, TaskStatus.BACKLOG],
  [TaskStatus.IN_PROGRESS]: [
    TaskStatus.REVIEW,
    TaskStatus.BLOCKED,
    TaskStatus.DONE,
    TaskStatus.FAILED,
  ],
  [TaskStatus.REVIEW]: [
    TaskStatus.DONE,
    TaskStatus.IN_PROGRESS,
    TaskStatus.BLOCKED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.BLOCKED]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.FAILED],
  [TaskStatus.DONE]: [],
  // A failed task is re-queued rather than resurrected in place.
  [TaskStatus.FAILED]: [TaskStatus.TODO],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === TaskStatus.DONE;
}

/**
 * Preconditions the graph imposes on entering IN_PROGRESS. Supplied by the
 * caller rather than fetched, because the domain does not do I/O.
 */
export interface TaskTransitionContext {
  /** Statuses of this task's dependencies, in any order. */
  dependencyStatuses?: readonly TaskStatus[];
}

export function transitionTask(
  task: Task,
  to: TaskStatus,
  clock: Clock,
  context: TaskTransitionContext = {},
): Task {
  if (!canTransitionTask(task.status, to)) {
    throw illegalTransitionError('task', task.status, to);
  }
  if (to === TaskStatus.IN_PROGRESS) {
    if (task.assignedAgentId === undefined) {
      throw illegalTransitionError('task', task.status, to, 'task has no assigned agent');
    }
    const unmet = (context.dependencyStatuses ?? []).filter((s) => s !== TaskStatus.DONE);
    if (unmet.length > 0) {
      throw illegalTransitionError(
        'task',
        task.status,
        to,
        `${unmet.length} unmet dependenc${unmet.length === 1 ? 'y' : 'ies'}`,
      );
    }
  }
  return { ...task, status: to, updatedAt: clock.now() };
}

// ── Assignment ───────────────────────────────────────────────────

/**
 * Assign or reassign. Identical for human-to-agent, manager-to-agent and
 * agent-to-agent: who requested it is recorded on the Task's `createdByAgentId`
 * at creation, and the assignment itself carries no notion of requester rank.
 */
export function assignTask(task: Task, agentId: AgentId, clock: Clock): Task {
  if (isTerminalTask(task.status)) {
    throw illegalTransitionError('task', task.status, task.status, 'cannot reassign a done task');
  }
  return { ...task, assignedAgentId: agentId, updatedAt: clock.now() };
}

export function unassignTask(task: Task, clock: Clock): Task {
  if (task.status === TaskStatus.IN_PROGRESS) {
    throw illegalTransitionError(
      'task',
      task.status,
      task.status,
      'cannot unassign a task in progress',
    );
  }
  const next: Task = { ...task, updatedAt: clock.now() };
  delete next.assignedAgentId;
  return next;
}

export function attachOutput(task: Task, outputId: OutputId, clock: Clock): Task {
  if (task.outputs.includes(outputId)) {
    return task;
  }
  return { ...task, outputs: [...task.outputs, outputId], updatedAt: clock.now() };
}

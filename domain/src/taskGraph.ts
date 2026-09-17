/**
 * Task graph validation.
 *
 * `dependencies[]` is a free-form edge list, which means it is a graph, which
 * means it can be made unexecutable: a task depending on itself, on a task in
 * another project, or on a cycle. The domain refuses all three (requirement 8).
 *
 * The same guards apply to `parentTaskId`, which is a *different* graph — a
 * decomposition tree. A task may not be its own ancestor either.
 *
 * Everything here is pure: callers supply the tasks, the domain does no I/O.
 */

import { crossProjectError, dependencyCycleError, validationError } from './errors.js';
import type { TaskId } from './ids.js';
import type { Task } from './task.js';

/** The subset of a task this module needs. Keeps callers free to pass partials. */
export interface TaskNode {
  id: TaskId;
  projectId: Task['projectId'];
  dependencies: readonly TaskId[];
  parentTaskId?: TaskId;
}

export const DependencyViolation = {
  SELF: 'self_dependency',
  CROSS_PROJECT: 'cross_project_dependency',
  UNKNOWN: 'unknown_dependency',
  CYCLE: 'dependency_cycle',
} as const;
export type DependencyViolation = (typeof DependencyViolation)[keyof typeof DependencyViolation];

function indexById(tasks: readonly TaskNode[]): Map<TaskId, TaskNode> {
  const index = new Map<TaskId, TaskNode>();
  for (const task of tasks) {
    index.set(task.id, task);
  }
  return index;
}

/**
 * Depth-first cycle search over the dependency edges.
 *
 * Returns the cycle as a path whose first and last element are the same task,
 * e.g. `[a, b, c, a]`, so the caller can show the user what to break. Returns
 * null when the graph is acyclic. Unknown dependency ids are ignored here —
 * `validateDependencyEdge` is what reports those — so a partially loaded graph
 * cannot produce a phantom cycle.
 *
 * Iterative rather than recursive: a deep decomposition from a Manager Agent
 * should not be able to blow the stack.
 */
export function findDependencyCycle(tasks: readonly TaskNode[]): TaskId[] | null {
  const index = indexById(tasks);
  const visited = new Set<TaskId>();
  const onPath = new Set<TaskId>();

  for (const root of tasks) {
    if (visited.has(root.id)) {
      continue;
    }
    // Each frame remembers how far through its own dependency list we are.
    const stack: Array<{ id: TaskId; cursor: number }> = [{ id: root.id, cursor: 0 }];
    const path: TaskId[] = [root.id];
    onPath.add(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const node = index.get(frame.id);
      const deps = node?.dependencies ?? [];

      if (frame.cursor >= deps.length) {
        visited.add(frame.id);
        onPath.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }

      const next = deps[frame.cursor]!;
      frame.cursor++;

      if (onPath.has(next)) {
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (visited.has(next) || !index.has(next)) {
        continue;
      }
      stack.push({ id: next, cursor: 0 });
      path.push(next);
      onPath.add(next);
    }
  }

  return null;
}

/** Same search, over `parentTaskId` edges. A task may not be its own ancestor. */
export function findParentCycle(tasks: readonly TaskNode[]): TaskId[] | null {
  const index = indexById(tasks);

  for (const root of tasks) {
    const path: TaskId[] = [root.id];
    const seen = new Set<TaskId>([root.id]);
    let cursor: TaskNode | undefined = root;

    while (cursor?.parentTaskId !== undefined) {
      const parentId: TaskId = cursor.parentTaskId;
      if (seen.has(parentId)) {
        const start = path.indexOf(parentId);
        return [...path.slice(start), parentId];
      }
      const parent = index.get(parentId);
      if (!parent) {
        break;
      }
      path.push(parentId);
      seen.add(parentId);
      cursor = parent;
    }
  }

  return null;
}

/**
 * Check one proposed edge in isolation: `task` wants to depend on `dependency`.
 * Returns the violation, or null when the edge is acceptable. Cycle detection is
 * separate because it needs the whole graph.
 */
export function validateDependencyEdge(
  task: TaskNode,
  dependency: TaskNode | undefined,
  dependencyId: TaskId,
): DependencyViolation | null {
  if (dependencyId === task.id) {
    return DependencyViolation.SELF;
  }
  if (!dependency) {
    return DependencyViolation.UNKNOWN;
  }
  if (dependency.projectId !== task.projectId) {
    return DependencyViolation.CROSS_PROJECT;
  }
  return null;
}

/**
 * Validate a task's complete dependency list against the graph it lives in, then
 * confirm the resulting graph is acyclic. Throws a DomainError on the first
 * problem; returns silently when the graph is sound.
 */
export function assertDependenciesValid(task: TaskNode, graph: readonly TaskNode[]): void {
  const index = indexById(graph);

  for (const dependencyId of task.dependencies) {
    const violation = validateDependencyEdge(task, index.get(dependencyId), dependencyId);
    if (violation === DependencyViolation.SELF) {
      throw validationError('a task cannot depend on itself', {
        taskId: task.id,
        violation,
      });
    }
    if (violation === DependencyViolation.UNKNOWN) {
      throw validationError('dependency does not exist', {
        taskId: task.id,
        dependencyId,
        violation,
      });
    }
    if (violation === DependencyViolation.CROSS_PROJECT) {
      throw crossProjectError('a task may only depend on tasks in the same project', {
        taskId: task.id,
        dependencyId,
        violation,
      });
    }
  }

  // The task under validation may be new, so it is folded into the graph rather
  // than assumed present.
  const merged = [...graph.filter((t) => t.id !== task.id), task];
  const cycle = findDependencyCycle(merged);
  if (cycle) {
    throw dependencyCycleError(cycle);
  }
}

/** Same contract for the decomposition tree. */
export function assertParentValid(task: TaskNode, graph: readonly TaskNode[]): void {
  if (task.parentTaskId === undefined) {
    return;
  }
  if (task.parentTaskId === task.id) {
    throw validationError('a task cannot be its own parent', { taskId: task.id });
  }
  const parent = graph.find((t) => t.id === task.parentTaskId);
  if (!parent) {
    throw validationError('parent task does not exist', {
      taskId: task.id,
      parentTaskId: task.parentTaskId,
    });
  }
  if (parent.projectId !== task.projectId) {
    throw crossProjectError('a subtask must belong to its parent task project', {
      taskId: task.id,
      parentTaskId: task.parentTaskId,
    });
  }
  const merged = [...graph.filter((t) => t.id !== task.id), task];
  const cycle = findParentCycle(merged);
  if (cycle) {
    throw validationError('task hierarchy contains a cycle', { cycle });
  }
}

/**
 * Dependency ids in an order that satisfies the graph, or null when a cycle
 * makes that impossible. Used later by the Manager Agent to decide what may run
 * now; here it doubles as an independent check on findDependencyCycle.
 */
export function topologicalOrder(tasks: readonly TaskNode[]): TaskId[] | null {
  const index = indexById(tasks);
  const ordered: TaskId[] = [];
  const state = new Map<TaskId, 'visiting' | 'done'>();

  const visit = (id: TaskId): boolean => {
    const current = state.get(id);
    if (current === 'done') {
      return true;
    }
    if (current === 'visiting') {
      return false;
    }
    state.set(id, 'visiting');
    for (const dependencyId of index.get(id)?.dependencies ?? []) {
      if (index.has(dependencyId) && !visit(dependencyId)) {
        return false;
      }
    }
    state.set(id, 'done');
    ordered.push(id);
    return true;
  };

  for (const task of tasks) {
    if (!visit(task.id)) {
      return null;
    }
  }
  return ordered;
}

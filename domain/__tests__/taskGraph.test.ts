/**
 * Task dependency validation and cycle detection (requirement 8).
 *
 * Also pins the separation of the two graphs: `parentTaskId` is decomposition,
 * `dependencies[]` is execution ordering, and neither implies the other.
 */

import { describe, expect, it } from 'vitest';

import type { ProjectId, TaskId, TaskNode } from '../src/index.js';
import {
  assertDependenciesValid,
  assertParentValid,
  createProject,
  createTask,
  DependencyViolation,
  findDependencyCycle,
  findParentCycle,
  topologicalOrder,
  validateDependencyEdge,
} from '../src/index.js';
import { testDeps } from './support.js';

/** Build a graph from a literal adjacency map, keeping ids readable in failures. */
function graphOf(
  projectId: ProjectId,
  edges: Record<string, string[]>,
  ids: Record<string, TaskId>,
): TaskNode[] {
  return Object.entries(edges).map(([name, deps]) => ({
    id: ids[name]!,
    projectId,
    dependencies: deps.map((d) => ids[d]!),
  }));
}

function world(names: string[]) {
  const deps = testDeps();
  const project = createProject({ name: 'AiWow' }, deps);
  const ids: Record<string, TaskId> = {};
  for (const name of names) {
    ids[name] = createTask({ projectId: project.id, title: name }, deps).id;
  }
  return { deps, project, ids };
}

describe('dependency edge validation', () => {
  it('rejects a self-dependency', () => {
    const { project, ids } = world(['a']);
    const a: TaskNode = { id: ids['a']!, projectId: project.id, dependencies: [ids['a']!] };

    expect(validateDependencyEdge(a, a, a.id)).toBe(DependencyViolation.SELF);
    expect(() => assertDependenciesValid(a, [a])).toThrow(/cannot depend on itself/);
  });

  it('rejects a dependency in another project', () => {
    const deps = testDeps();
    const one = createProject({ name: 'One' }, deps);
    const two = createProject({ name: 'Two' }, deps);
    const mine = createTask({ projectId: one.id, title: 'mine' }, deps);
    const theirs = createTask({ projectId: two.id, title: 'theirs' }, deps);

    const node: TaskNode = {
      id: mine.id,
      projectId: one.id,
      dependencies: [theirs.id],
    };
    const foreign: TaskNode = { id: theirs.id, projectId: two.id, dependencies: [] };

    expect(validateDependencyEdge(node, foreign, theirs.id)).toBe(
      DependencyViolation.CROSS_PROJECT,
    );
    expect(() => assertDependenciesValid(node, [node, foreign])).toThrow(/same project/);
  });

  it('rejects a dependency that does not exist', () => {
    const { project, ids } = world(['a', 'ghost']);
    const a: TaskNode = { id: ids['a']!, projectId: project.id, dependencies: [ids['ghost']!] };

    expect(validateDependencyEdge(a, undefined, ids['ghost']!)).toBe(DependencyViolation.UNKNOWN);
    expect(() => assertDependenciesValid(a, [a])).toThrow(/dependency does not exist/);
  });

  it('accepts a sound edge', () => {
    const { project, ids } = world(['a', 'b']);
    const graph = graphOf(project.id, { a: ['b'], b: [] }, ids);
    expect(validateDependencyEdge(graph[0]!, graph[1]!, ids['b']!)).toBeNull();
    expect(() => assertDependenciesValid(graph[0]!, graph)).not.toThrow();
  });
});

describe('dependency cycle detection', () => {
  it('finds no cycle in an acyclic graph', () => {
    const { project, ids } = world(['a', 'b', 'c', 'd']);
    const graph = graphOf(project.id, { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }, ids);
    expect(findDependencyCycle(graph)).toBeNull();
  });

  it('finds a direct self-loop', () => {
    const { project, ids } = world(['a']);
    const graph = graphOf(project.id, { a: ['a'] }, ids);
    expect(findDependencyCycle(graph)).toEqual([ids['a'], ids['a']]);
  });

  it('finds a two-task cycle', () => {
    const { project, ids } = world(['a', 'b']);
    const graph = graphOf(project.id, { a: ['b'], b: ['a'] }, ids);
    const cycle = findDependencyCycle(graph);

    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    expect(new Set(cycle)).toEqual(new Set([ids['a'], ids['b']]));
  });

  it('finds a longer cycle and reports the path', () => {
    const { project, ids } = world(['a', 'b', 'c']);
    const graph = graphOf(project.id, { a: ['b'], b: ['c'], c: ['a'] }, ids);
    const cycle = findDependencyCycle(graph)!;

    expect(cycle).toHaveLength(4);
    expect(cycle[0]).toBe(cycle[3]);
  });

  it('finds a cycle that does not include the first node visited', () => {
    const { project, ids } = world(['root', 'a', 'b']);
    const graph = graphOf(project.id, { root: ['a'], a: ['b'], b: ['a'] }, ids);
    const cycle = findDependencyCycle(graph)!;

    expect(new Set(cycle)).toEqual(new Set([ids['a'], ids['b']]));
    expect(cycle).not.toContain(ids['root']);
  });

  it('ignores dangling ids rather than inventing a cycle', () => {
    const { project, ids } = world(['a', 'missing']);
    const graph: TaskNode[] = [
      { id: ids['a']!, projectId: project.id, dependencies: [ids['missing']!] },
    ];
    expect(findDependencyCycle(graph)).toBeNull();
  });

  it('survives a deep chain without blowing the stack', () => {
    const deps = testDeps();
    const project = createProject({ name: 'Deep' }, deps);
    const chain: TaskNode[] = [];
    const created = Array.from({ length: 5000 }, (_, i) =>
      createTask({ projectId: project.id, title: `t${i}` }, deps),
    );
    for (let i = 0; i < created.length; i++) {
      const next = created[i + 1];
      chain.push({
        id: created[i]!.id,
        projectId: project.id,
        dependencies: next ? [next.id] : [],
      });
    }

    expect(findDependencyCycle(chain)).toBeNull();

    // Close the loop; the same traversal must now find it.
    chain[chain.length - 1]!.dependencies = [chain[0]!.id];
    expect(findDependencyCycle(chain)).not.toBeNull();
  });

  it('throws when validation folds a new task into a graph and closes a loop', () => {
    const { project, ids } = world(['a', 'b']);
    const existing = graphOf(project.id, { a: ['b'], b: [] }, ids);
    // b now wants to depend on a — that closes a -> b -> a.
    const revisedB: TaskNode = { id: ids['b']!, projectId: project.id, dependencies: [ids['a']!] };

    expect(() => assertDependenciesValid(revisedB, existing)).toThrow(/dependency cycle/);
  });

  it('agrees with an independent topological sort', () => {
    const { project, ids } = world(['a', 'b', 'c']);
    const acyclic = graphOf(project.id, { a: ['b'], b: ['c'], c: [] }, ids);
    const cyclic = graphOf(project.id, { a: ['b'], b: ['c'], c: ['a'] }, ids);

    expect(findDependencyCycle(acyclic)).toBeNull();
    expect(topologicalOrder(acyclic)).toEqual([ids['c'], ids['b'], ids['a']]);

    expect(findDependencyCycle(cyclic)).not.toBeNull();
    expect(topologicalOrder(cyclic)).toBeNull();
  });
});

describe('parent hierarchy is a different graph from dependencies', () => {
  it('rejects a task that is its own parent', () => {
    const { project, ids } = world(['a']);
    const a: TaskNode = {
      id: ids['a']!,
      projectId: project.id,
      dependencies: [],
      parentTaskId: ids['a']!,
    };
    expect(() => assertParentValid(a, [a])).toThrow(/its own parent/);
  });

  it('rejects a parent cycle', () => {
    const { project, ids } = world(['a', 'b']);
    const a: TaskNode = {
      id: ids['a']!,
      projectId: project.id,
      dependencies: [],
      parentTaskId: ids['b']!,
    };
    const b: TaskNode = {
      id: ids['b']!,
      projectId: project.id,
      dependencies: [],
      parentTaskId: ids['a']!,
    };
    expect(findParentCycle([a, b])).not.toBeNull();
    expect(() => assertParentValid(a, [a, b])).toThrow(/hierarchy contains a cycle/);
  });

  it('rejects a subtask in a different project from its parent', () => {
    const deps = testDeps();
    const one = createProject({ name: 'One' }, deps);
    const two = createProject({ name: 'Two' }, deps);
    const parent = createTask({ projectId: two.id, title: 'parent' }, deps);
    const child = createTask({ projectId: one.id, title: 'child' }, deps);

    const childNode: TaskNode = {
      id: child.id,
      projectId: one.id,
      dependencies: [],
      parentTaskId: parent.id,
    };
    const parentNode: TaskNode = { id: parent.id, projectId: two.id, dependencies: [] };

    expect(() => assertParentValid(childNode, [childNode, parentNode])).toThrow(
      /parent task project/,
    );
  });

  it('accepts a subtask that does NOT depend on its parent', () => {
    const { project, ids } = world(['parent', 'child']);
    const parent: TaskNode = { id: ids['parent']!, projectId: project.id, dependencies: [] };
    const child: TaskNode = {
      id: ids['child']!,
      projectId: project.id,
      dependencies: [],
      parentTaskId: ids['parent']!,
    };

    // Decomposition without execution ordering is the normal case.
    expect(() => assertParentValid(child, [parent, child])).not.toThrow();
    expect(() => assertDependenciesValid(child, [parent, child])).not.toThrow();
    expect(child.dependencies).toEqual([]);
  });

  it('accepts a dependency between tasks that are not parent and child', () => {
    const { project, ids } = world(['a', 'b']);
    const a: TaskNode = { id: ids['a']!, projectId: project.id, dependencies: [ids['b']!] };
    const b: TaskNode = { id: ids['b']!, projectId: project.id, dependencies: [] };

    expect(() => assertDependenciesValid(a, [a, b])).not.toThrow();
    expect(a.parentTaskId).toBeUndefined();
  });
});

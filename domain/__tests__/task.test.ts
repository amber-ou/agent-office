/**
 * Task lifecycle and assignment.
 */

import { describe, expect, it } from 'vitest';

import {
  assignTask,
  attachOutput,
  canTransitionTask,
  createAgentDefinition,
  createOutputItem,
  createProject,
  createTask,
  OutputType,
  TaskPriority,
  TaskStatus,
  transitionTask,
  unassignTask,
} from '../src/index.js';
import { testDeps } from './support.js';

function world() {
  const deps = testDeps();
  const project = createProject({ name: 'AiWow' }, deps);
  const manager = createAgentDefinition(
    { name: 'Manager Agent', role: 'manager', provider: 'claude' },
    deps,
  );
  const spec = createAgentDefinition(
    { name: 'Spec Agent', role: 'spec', provider: 'claude' },
    deps,
  );
  return { deps, project, manager, spec };
}

describe('Task creation', () => {
  it('starts in backlog with normal priority and no assignee', () => {
    const { deps, project } = world();
    const task = createTask({ projectId: project.id, title: 'Write the PRD' }, deps);

    expect(task.status).toBe(TaskStatus.BACKLOG);
    expect(task.priority).toBe(TaskPriority.NORMAL);
    expect(task.assignedAgentId).toBeUndefined();
    expect(task.createdByAgentId).toBeUndefined();
    expect(task.dependencies).toEqual([]);
    expect(task.outputs).toEqual([]);
  });

  it('records the creating agent for manager-to-agent and agent-to-agent work', () => {
    const { deps, project, manager, spec } = world();
    const task = createTask(
      {
        projectId: project.id,
        title: 'Draft acceptance criteria',
        createdByAgentId: manager.id,
        assignedAgentId: spec.id,
      },
      deps,
    );

    expect(task.createdByAgentId).toBe(manager.id);
    expect(task.assignedAgentId).toBe(spec.id);
  });

  it('rejects an empty title', () => {
    const { deps, project } = world();
    expect(() => createTask({ projectId: project.id, title: '' }, deps)).toThrow(/task.title/);
  });
});

describe('Task lifecycle', () => {
  it('allows the documented transitions and refuses the rest', () => {
    expect(canTransitionTask(TaskStatus.BACKLOG, TaskStatus.TODO)).toBe(true);
    expect(canTransitionTask(TaskStatus.TODO, TaskStatus.IN_PROGRESS)).toBe(true);
    expect(canTransitionTask(TaskStatus.IN_PROGRESS, TaskStatus.REVIEW)).toBe(true);
    expect(canTransitionTask(TaskStatus.REVIEW, TaskStatus.DONE)).toBe(true);
    expect(canTransitionTask(TaskStatus.FAILED, TaskStatus.TODO)).toBe(true);

    expect(canTransitionTask(TaskStatus.BACKLOG, TaskStatus.IN_PROGRESS)).toBe(false);
    expect(canTransitionTask(TaskStatus.DONE, TaskStatus.IN_PROGRESS)).toBe(false);
    expect(canTransitionTask(TaskStatus.TODO, TaskStatus.DONE)).toBe(false);
  });

  it('refuses IN_PROGRESS without an assigned agent', () => {
    const { deps, project } = world();
    const todo = transitionTask(
      createTask({ projectId: project.id, title: 'Unowned' }, deps),
      TaskStatus.TODO,
      deps.clock,
    );

    expect(() => transitionTask(todo, TaskStatus.IN_PROGRESS, deps.clock)).toThrow(
      /no assigned agent/,
    );
  });

  it('refuses IN_PROGRESS while a dependency is unfinished', () => {
    const { deps, project, spec } = world();
    const todo = transitionTask(
      createTask({ projectId: project.id, title: 'Build UI', assignedAgentId: spec.id }, deps),
      TaskStatus.TODO,
      deps.clock,
    );

    expect(() =>
      transitionTask(todo, TaskStatus.IN_PROGRESS, deps.clock, {
        dependencyStatuses: [TaskStatus.DONE, TaskStatus.IN_PROGRESS],
      }),
    ).toThrow(/1 unmet dependency/);

    expect(() =>
      transitionTask(todo, TaskStatus.IN_PROGRESS, deps.clock, {
        dependencyStatuses: [TaskStatus.DONE, TaskStatus.DONE],
      }),
    ).not.toThrow();
  });

  it('walks a full happy path and bumps updatedAt each step', () => {
    const { deps, project, spec } = world();
    let task = createTask(
      { projectId: project.id, title: 'Ship it', assignedAgentId: spec.id },
      deps,
    );
    const created = task.updatedAt;

    task = transitionTask(task, TaskStatus.TODO, deps.clock);
    task = transitionTask(task, TaskStatus.IN_PROGRESS, deps.clock);
    task = transitionTask(task, TaskStatus.REVIEW, deps.clock);
    task = transitionTask(task, TaskStatus.DONE, deps.clock);

    expect(task.status).toBe(TaskStatus.DONE);
    expect(task.updatedAt).not.toBe(created);
    expect(task.createdAt).toBe(created);
  });

  it('re-queues a failed task rather than resurrecting it in place', () => {
    const { deps, project, spec } = world();
    const failed = transitionTask(
      transitionTask(
        transitionTask(
          createTask({ projectId: project.id, title: 'Flaky', assignedAgentId: spec.id }, deps),
          TaskStatus.TODO,
          deps.clock,
        ),
        TaskStatus.IN_PROGRESS,
        deps.clock,
      ),
      TaskStatus.FAILED,
      deps.clock,
    );

    expect(() => transitionTask(failed, TaskStatus.IN_PROGRESS, deps.clock)).toThrow(
      /illegal task transition/,
    );
    expect(transitionTask(failed, TaskStatus.TODO, deps.clock).status).toBe(TaskStatus.TODO);
  });
});

describe('Task assignment', () => {
  it('supports human-to-agent, manager-to-agent and agent-to-agent alike', () => {
    const { deps, project, manager, spec } = world();
    const humanCreated = createTask({ projectId: project.id, title: 'From a human' }, deps);
    const managerCreated = createTask(
      { projectId: project.id, title: 'From the manager', createdByAgentId: manager.id },
      deps,
    );
    const peerCreated = createTask(
      { projectId: project.id, title: 'From a peer', createdByAgentId: spec.id },
      deps,
    );

    for (const task of [humanCreated, managerCreated, peerCreated]) {
      expect(assignTask(task, spec.id, deps.clock).assignedAgentId).toBe(spec.id);
    }
  });

  it('reassigns freely before done, and never after', () => {
    const { deps, project, manager, spec } = world();
    let task = createTask(
      { projectId: project.id, title: 'Movable', assignedAgentId: spec.id },
      deps,
    );
    task = assignTask(task, manager.id, deps.clock);
    expect(task.assignedAgentId).toBe(manager.id);

    const done = transitionTask(
      transitionTask(
        transitionTask(task, TaskStatus.TODO, deps.clock),
        TaskStatus.IN_PROGRESS,
        deps.clock,
      ),
      TaskStatus.DONE,
      deps.clock,
    );
    expect(() => assignTask(done, spec.id, deps.clock)).toThrow(/cannot reassign a done task/);
  });

  it('refuses to unassign a task that is in progress', () => {
    const { deps, project, spec } = world();
    const inProgress = transitionTask(
      transitionTask(
        createTask({ projectId: project.id, title: 'Running', assignedAgentId: spec.id }, deps),
        TaskStatus.TODO,
        deps.clock,
      ),
      TaskStatus.IN_PROGRESS,
      deps.clock,
    );

    expect(() => unassignTask(inProgress, deps.clock)).toThrow(/in progress/);

    const todo = transitionTask(
      createTask({ projectId: project.id, title: 'Queued', assignedAgentId: spec.id }, deps),
      TaskStatus.TODO,
      deps.clock,
    );
    expect(unassignTask(todo, deps.clock).assignedAgentId).toBeUndefined();
  });

  it("carries one agent's output into another agent's input", () => {
    const { deps, project, spec } = world();
    const specTask = createTask(
      { projectId: project.id, title: 'Write the spec', assignedAgentId: spec.id },
      deps,
    );
    const output = createOutputItem(
      {
        projectId: project.id,
        taskId: specTask.id,
        producedByAgentId: spec.id,
        title: 'Spec v1',
        type: OutputType.MARKDOWN,
        location: { store: 'inline', content: '# spec' },
      },
      deps,
    );
    const withOutput = attachOutput(specTask, output.id, deps.clock);
    expect(withOutput.outputs).toEqual([output.id]);
    expect(attachOutput(withOutput, output.id, deps.clock).outputs).toHaveLength(1);

    // The handoff is expressible in the type system, not by string concatenation.
    const uiTask = createTask(
      {
        projectId: project.id,
        title: 'Build from the spec',
        inputs: [{ kind: 'output', outputId: output.id }],
      },
      deps,
    );
    const [input] = uiTask.inputs;
    expect(input).toEqual({ kind: 'output', outputId: output.id });
  });
});

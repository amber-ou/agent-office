/**
 * Agent status precedence (requirement 4).
 *
 * The table these tests pin:
 *
 *   1 error  2 blocked  3 reviewing  4 working  5 waiting  6 idle  7 offline
 *
 * The contradiction the precedence exists to prevent — "task = blocked, runtime
 * = active, agent = waiting" — is tested explicitly at the bottom.
 */

import { describe, expect, it } from 'vitest';

import type { AgentSession, ObservedRuntimeState, Task } from '../src/index.js';
import {
  AgentStatus,
  agentStatusOf,
  AgentStatusReason,
  createAgentDefinition,
  createProject,
  createTask,
  resolveAgentStatus,
  SessionStatus,
  startSession,
  TaskStatus,
  transitionSession,
  unobserved,
} from '../src/index.js';
import { testDeps } from './support.js';

function world() {
  const deps = testDeps();
  const project = createProject({ name: 'AiWow' }, deps);
  const agent = createAgentDefinition({ name: 'QA Agent', role: 'qa', provider: 'claude' }, deps);
  const task = createTask(
    { projectId: project.id, title: 'Regression sweep', assignedAgentId: agent.id },
    deps,
  );
  const session = transitionSession(
    startSession({ agentId: agent.id, projectId: project.id, provider: 'claude' }, deps),
    SessionStatus.RUNNING,
    deps.clock,
  );
  return { deps, project, agent, task, session };
}

const observing = (over: Partial<ObservedRuntimeState> = {}): ObservedRuntimeState => ({
  ...unobserved(),
  ...over,
});

const withStatus = (task: Task, status: TaskStatus): Task => ({ ...task, status });
const sessionWith = (session: AgentSession, status: SessionStatus): AgentSession => ({
  ...session,
  status,
});

describe('resolveAgentStatus precedence', () => {
  it('1. a failed session is error, even while the runtime looks active', () => {
    const { session, task } = world();
    const result = resolveAgentStatus({
      session: sessionWith(session, SessionStatus.FAILED),
      task,
      observed: observing({ active: true }),
    });
    expect(result).toEqual({
      status: AgentStatus.ERROR,
      reason: AgentStatusReason.SESSION_FAILED,
    });
  });

  it('1. a runtime-reported failure is error', () => {
    const { session, task } = world();
    expect(resolveAgentStatus({ session, task, observed: observing({ failed: true }) })).toEqual({
      status: AgentStatus.ERROR,
      reason: AgentStatusReason.RUNTIME_FAILED,
    });
  });

  it('1. a failed task is error', () => {
    const { session, task } = world();
    expect(
      resolveAgentStatus({
        session,
        task: withStatus(task, TaskStatus.FAILED),
        observed: observing({ active: true }),
      }),
    ).toEqual({ status: AgentStatus.ERROR, reason: AgentStatusReason.TASK_FAILED });
  });

  it('2. blocked outranks an active runtime', () => {
    const { session, task } = world();
    expect(
      resolveAgentStatus({
        session,
        task: withStatus(task, TaskStatus.BLOCKED),
        observed: observing({ active: true }),
      }),
    ).toEqual({ status: AgentStatus.BLOCKED, reason: AgentStatusReason.TASK_BLOCKED });
  });

  it('3. review outranks an active runtime but yields to blocked', () => {
    const { session, task } = world();
    expect(
      agentStatusOf({
        session,
        task: withStatus(task, TaskStatus.REVIEW),
        observed: observing({ active: true }),
      }),
    ).toBe(AgentStatus.REVIEWING);
  });

  it('4. an active runtime is working', () => {
    const { session, task } = world();
    expect(
      resolveAgentStatus({
        session,
        task: withStatus(task, TaskStatus.IN_PROGRESS),
        observed: observing({ active: true }),
      }),
    ).toEqual({ status: AgentStatus.WORKING, reason: AgentStatusReason.RUNTIME_ACTIVE });
  });

  it('5. a pending permission is waiting', () => {
    const { session, task } = world();
    expect(
      resolveAgentStatus({
        session,
        task: withStatus(task, TaskStatus.IN_PROGRESS),
        observed: observing({ permissionPending: true }),
      }),
    ).toEqual({
      status: AgentStatus.WAITING,
      reason: AgentStatusReason.RUNTIME_PERMISSION_PENDING,
    });
  });

  it('5. awaiting human input is waiting', () => {
    const { session, task } = world();
    expect(
      resolveAgentStatus({
        session,
        task: withStatus(task, TaskStatus.IN_PROGRESS),
        observed: observing({ awaitingInput: true }),
      }),
    ).toEqual({
      status: AgentStatus.WAITING,
      reason: AgentStatusReason.RUNTIME_AWAITING_INPUT,
    });
  });

  it('6. a live but quiet session is idle', () => {
    const { session } = world();
    expect(resolveAgentStatus({ session, observed: observing() })).toEqual({
      status: AgentStatus.IDLE,
      reason: AgentStatusReason.SESSION_LIVE_QUIET,
    });
  });

  it('6. a live session with a todo task is still idle', () => {
    const { session, task } = world();
    expect(agentStatusOf({ session, task: withStatus(task, TaskStatus.TODO) })).toBe(
      AgentStatus.IDLE,
    );
  });

  it('7. no session at all is offline', () => {
    expect(resolveAgentStatus({})).toEqual({
      status: AgentStatus.OFFLINE,
      reason: AgentStatusReason.NO_LIVE_SESSION,
    });
  });

  it('7. an ended session is offline, not idle', () => {
    const { session } = world();
    expect(agentStatusOf({ session: sessionWith(session, SessionStatus.ENDED) })).toBe(
      AgentStatus.OFFLINE,
    );
  });

  it('7. a done task with no live session is offline', () => {
    const { session, task } = world();
    expect(
      agentStatusOf({
        session: sessionWith(session, SessionStatus.ENDED),
        task: withStatus(task, TaskStatus.DONE),
      }),
    ).toBe(AgentStatus.OFFLINE);
  });
});

describe('resolveAgentStatus consistency', () => {
  it('never produces the contradiction the precedence exists to prevent', () => {
    const { session, task } = world();
    // Task blocked + runtime active. There is exactly one answer, and it is not
    // "waiting" — the status is derived, so the two inputs cannot disagree with
    // the output.
    const result = resolveAgentStatus({
      session,
      task: withStatus(task, TaskStatus.BLOCKED),
      observed: observing({ active: true, awaitingInput: true, permissionPending: true }),
    });
    expect(result.status).toBe(AgentStatus.BLOCKED);
    expect(result.status).not.toBe(AgentStatus.WAITING);
    expect(result.status).not.toBe(AgentStatus.WORKING);
  });

  it('is a pure function of its inputs', () => {
    const { session, task } = world();
    const input = { session, task, observed: observing({ active: true }) };
    expect(resolveAgentStatus(input)).toEqual(resolveAgentStatus(input));
  });

  it('covers every status in the union', () => {
    const { session, task } = world();
    const produced = new Set([
      agentStatusOf({ session: sessionWith(session, SessionStatus.FAILED) }),
      agentStatusOf({ session, task: withStatus(task, TaskStatus.BLOCKED) }),
      agentStatusOf({ session, task: withStatus(task, TaskStatus.REVIEW) }),
      agentStatusOf({ session, observed: observing({ active: true }) }),
      agentStatusOf({ session, observed: observing({ awaitingInput: true }) }),
      agentStatusOf({ session }),
      agentStatusOf({}),
    ]);
    expect(produced).toEqual(
      new Set([
        AgentStatus.ERROR,
        AgentStatus.BLOCKED,
        AgentStatus.REVIEWING,
        AgentStatus.WORKING,
        AgentStatus.WAITING,
        AgentStatus.IDLE,
        AgentStatus.OFFLINE,
      ]),
    );
  });
});

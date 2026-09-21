/**
 * Agent status — DERIVED, never stored.
 *
 * Three different things are routinely confused, so they are three types here:
 *
 *   ObservedRuntimeState  what the runtime is doing   (observation, upstream)
 *   TaskStatus            what the work is doing      (control plane)
 *   AgentStatus           what the office shows       (derived from both)
 *
 * `AgentStatus` is a pure function of the other two. It is not a mutable field
 * that several call sites may write, which is what would let "task = blocked,
 * runtime = active, agent = waiting" exist at the same time. There is exactly
 * one writer — this function — and it has one precedence order.
 *
 * PRECEDENCE (first match wins):
 *
 *   1. error      runtime failed, or the task failed
 *   2. blocked    task is blocked
 *   3. reviewing  task is in review
 *   4. working    runtime is active
 *   5. waiting    runtime is awaiting input or a permission decision
 *   6. idle       a live session exists and none of the above applies
 *   7. offline    no live session — the runtime is unavailable
 *
 * Task state outranks runtime state (1-3 above 4-5) on purpose. A task that is
 * blocked or under review is a fact about the work; a runtime that is still
 * chewing is a fact about a process. When they disagree, the work wins, because
 * that is what a human asking "what is this agent doing" means.
 *
 * Rules 6 and 7 partition the "nothing notable is happening" case by whether a
 * live session exists at all: live but quiet is `idle`, nothing live is
 * `offline`.
 */

import type { AgentSession } from './agentSession.js';
import { isLiveSession, SessionStatus } from './agentSession.js';
import type { Task } from './task.js';
import { TaskStatus } from './task.js';

export const AgentStatus = {
  OFFLINE: 'offline',
  IDLE: 'idle',
  WORKING: 'working',
  WAITING: 'waiting',
  REVIEWING: 'reviewing',
  BLOCKED: 'blocked',
  ERROR: 'error',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

/**
 * What the observation plane reports. Upstream's wire protocol carries only
 * `active | waiting` plus permission bubbles, so this is the whole of what an
 * `AgentEvent` stream can tell us — deliberately narrow, so it is obvious that
 * `reviewing` / `blocked` / `error` cannot come from here.
 */
export interface ObservedRuntimeState {
  /** The runtime is executing a turn. */
  active: boolean;
  /** The runtime ended its turn waiting on a human reply. */
  awaitingInput: boolean;
  /** The runtime is stopped on a tool-permission decision. */
  permissionPending: boolean;
  /** The runtime reported a hard failure. */
  failed?: boolean;
}

/** Which rule in the precedence table produced the status. */
export const AgentStatusReason = {
  SESSION_FAILED: 'session_failed',
  RUNTIME_FAILED: 'runtime_failed',
  TASK_FAILED: 'task_failed',
  TASK_BLOCKED: 'task_blocked',
  TASK_IN_REVIEW: 'task_in_review',
  RUNTIME_ACTIVE: 'runtime_active',
  RUNTIME_AWAITING_INPUT: 'runtime_awaiting_input',
  RUNTIME_PERMISSION_PENDING: 'runtime_permission_pending',
  SESSION_LIVE_QUIET: 'session_live_quiet',
  NO_LIVE_SESSION: 'no_live_session',
} as const;
export type AgentStatusReason = (typeof AgentStatusReason)[keyof typeof AgentStatusReason];

export interface AgentStatusInput {
  /** The agent's current session, if it has one. */
  session?: AgentSession;
  /** The task the agent is currently on, if any. */
  task?: Task;
  /** What the observation plane last reported. Absent = nothing observed. */
  observed?: ObservedRuntimeState;
}

export interface AgentStatusResolution {
  status: AgentStatus;
  reason: AgentStatusReason;
}

/**
 * Resolve the displayed status, with the rule that fired.
 *
 * The reason is returned rather than logged because the Inspector will need to
 * answer "why is this agent shown as blocked when it is clearly typing" without
 * anyone re-deriving the table from memory.
 */
export function resolveAgentStatus(input: AgentStatusInput): AgentStatusResolution {
  const { session, task, observed } = input;

  // 1. error
  if (session?.status === SessionStatus.FAILED) {
    return { status: AgentStatus.ERROR, reason: AgentStatusReason.SESSION_FAILED };
  }
  if (observed?.failed === true) {
    return { status: AgentStatus.ERROR, reason: AgentStatusReason.RUNTIME_FAILED };
  }
  if (task?.status === TaskStatus.FAILED) {
    return { status: AgentStatus.ERROR, reason: AgentStatusReason.TASK_FAILED };
  }

  // 2. blocked
  if (task?.status === TaskStatus.BLOCKED) {
    return { status: AgentStatus.BLOCKED, reason: AgentStatusReason.TASK_BLOCKED };
  }

  // 3. reviewing
  if (task?.status === TaskStatus.REVIEW) {
    return { status: AgentStatus.REVIEWING, reason: AgentStatusReason.TASK_IN_REVIEW };
  }

  // 4. working
  if (observed?.active === true) {
    return { status: AgentStatus.WORKING, reason: AgentStatusReason.RUNTIME_ACTIVE };
  }

  // 5. waiting
  if (observed?.permissionPending === true) {
    return {
      status: AgentStatus.WAITING,
      reason: AgentStatusReason.RUNTIME_PERMISSION_PENDING,
    };
  }
  if (observed?.awaitingInput === true) {
    return { status: AgentStatus.WAITING, reason: AgentStatusReason.RUNTIME_AWAITING_INPUT };
  }

  // 6. idle — a live session exists but nothing notable is happening
  if (session !== undefined && isLiveSession(session.status)) {
    return { status: AgentStatus.IDLE, reason: AgentStatusReason.SESSION_LIVE_QUIET };
  }

  // 7. offline — no live session, so the runtime is unavailable
  return { status: AgentStatus.OFFLINE, reason: AgentStatusReason.NO_LIVE_SESSION };
}

/** The status alone, for callers that do not need the reason. */
export function agentStatusOf(input: AgentStatusInput): AgentStatus {
  return resolveAgentStatus(input).status;
}

/** Nothing observed yet — the neutral input for an agent with no live runtime. */
export function unobserved(): ObservedRuntimeState {
  return { active: false, awaitingInput: false, permissionPending: false };
}

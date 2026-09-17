/**
 * AgentSession — "one runtime instance of this agent".
 *
 * The only place in the domain that is allowed to know about a provider's own
 * identifiers. `id` is the canonical Agent Office identity; everything under the
 * "external runtime identity" heading is integration metadata that may be
 * absent, may be non-unique, and is never a key (ADR 002).
 *
 * Ending a session never touches the AgentDefinition it ran.
 */

import type { Clock, DomainDeps, Timestamp } from './clock.js';
import { illegalTransitionError, requireText } from './errors.js';
import type { AgentId, ProjectId, SessionId, TaskId } from './ids.js';
import { newSessionId } from './ids.js';

export const SessionStatus = {
  /** Requested, runtime not confirmed up yet. */
  STARTING: 'starting',
  /** Live and executing. */
  RUNNING: 'running',
  /** Live but not executing — between turns. */
  IDLE: 'idle',
  /** Finished normally. Terminal. */
  ENDED: 'ended',
  /** Crashed, timed out, or failed to start. Terminal. */
  FAILED: 'failed',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

const LIVE_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  SessionStatus.STARTING,
  SessionStatus.RUNNING,
  SessionStatus.IDLE,
]);

export function isLiveSession(status: SessionStatus): boolean {
  return LIVE_SESSION_STATUSES.has(status);
}

export function isTerminalSession(status: SessionStatus): boolean {
  return !isLiveSession(status);
}

export interface AgentSession {
  // ── Canonical identity ──
  id: SessionId;
  agentId: AgentId;
  projectId: ProjectId;
  /** The task this run exists to perform. Absent for an exploratory session. */
  taskId?: TaskId;
  /** Provider id this run uses, e.g. 'claude'. */
  provider: string;
  status: SessionStatus;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  /**
   * Stamped by the Control Plane on receipt, never copied from a runtime's own
   * clock — two machines do not share one (see clock.ts).
   */
  lastHeartbeatAt?: Timestamp;
  /** Set when status is FAILED. */
  error?: string;

  // ── External runtime identity: integration metadata only ──
  /**
   * The provider's own id for this run (Claude's session UUID, a Codex runtime
   * id, …). Optional by design: a provider may not have one, may not report it
   * until later, and may reuse one across runs. Never a primary key, never
   * assumed unique — `AgentSessionRepository.listByProviderSessionId` returns a
   * list for exactly that reason.
   */
  providerSessionId?: string;
  /** Which Agent Runtime host is executing this session. */
  runtimeId?: string;
  /** Provider transcript handle, when the provider keeps one. */
  transcriptPath?: string;
  /**
   * Upstream `AgentStateStore`'s numeric agent id, for reconciling this session
   * with the character in the office. Process-local and invalidated by any
   * restart, which is precisely why it is not an identity.
   */
  runtimeAgentId?: number;
}

export interface StartSessionInput {
  agentId: AgentId;
  projectId: ProjectId;
  provider: string;
  taskId?: TaskId;
  runtimeId?: string;
  providerSessionId?: string;
}

export function startSession(input: StartSessionInput, deps: DomainDeps): AgentSession {
  return {
    id: newSessionId(deps.ids),
    agentId: input.agentId,
    projectId: input.projectId,
    taskId: input.taskId,
    provider: requireText('session.provider', input.provider),
    status: SessionStatus.STARTING,
    startedAt: deps.clock.now(),
    runtimeId: input.runtimeId,
    providerSessionId: input.providerSessionId,
  };
}

// ── Transitions ──────────────────────────────────────────────────

const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  [SessionStatus.STARTING]: [SessionStatus.RUNNING, SessionStatus.IDLE, SessionStatus.FAILED],
  [SessionStatus.RUNNING]: [SessionStatus.IDLE, SessionStatus.ENDED, SessionStatus.FAILED],
  [SessionStatus.IDLE]: [SessionStatus.RUNNING, SessionStatus.ENDED, SessionStatus.FAILED],
  [SessionStatus.ENDED]: [],
  [SessionStatus.FAILED]: [],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export interface TransitionSessionOptions {
  error?: string;
}

export function transitionSession(
  session: AgentSession,
  to: SessionStatus,
  clock: Clock,
  options: TransitionSessionOptions = {},
): AgentSession {
  if (!canTransitionSession(session.status, to)) {
    throw illegalTransitionError('session', session.status, to);
  }
  const next: AgentSession = { ...session, status: to };
  if (isTerminalSession(to)) {
    next.endedAt = clock.now();
  }
  if (to === SessionStatus.FAILED) {
    next.error = options.error ?? session.error ?? 'session failed';
  }
  return next;
}

/** Record a heartbeat. The Control Plane's clock stamps it, not the runtime's. */
export function recordHeartbeat(session: AgentSession, clock: Clock): AgentSession {
  return { ...session, lastHeartbeatAt: clock.now() };
}

/**
 * Attach or refresh the provider's own identifiers once the runtime reports
 * them. Separated from `transitionSession` so integration metadata arriving late
 * is never entangled with lifecycle.
 */
export interface ExternalRuntimeRef {
  providerSessionId?: string;
  runtimeId?: string;
  transcriptPath?: string;
  runtimeAgentId?: number;
}

export function bindExternalRuntime(session: AgentSession, ref: ExternalRuntimeRef): AgentSession {
  return {
    ...session,
    providerSessionId: ref.providerSessionId ?? session.providerSessionId,
    runtimeId: ref.runtimeId ?? session.runtimeId,
    transcriptPath: ref.transcriptPath ?? session.transcriptPath,
    runtimeAgentId: ref.runtimeAgentId ?? session.runtimeAgentId,
  };
}

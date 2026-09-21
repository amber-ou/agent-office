/**
 * AgentRuntimeAdapter — the Control Plane's only way to reach an executor.
 *
 * INTERFACE ONLY in Milestone 1. No Claude runtime, no Codex runtime, no MCP
 * server, no process spawning, no WebSocket bridge. Those are Milestone 6.
 *
 * Why this exists now: declaring the seam early is what keeps the Control Plane
 * from growing provider assumptions. Everything below is expressed in domain
 * terms — an `AgentContextBundle` in, a provider session id out — so a runtime
 * that runs Claude Code locally and one that runs a Codex agent on another
 * machine are the same shape to the caller (ADR 003, ADR 004).
 *
 * Note the direction: this is the DOWNWARD channel. Upstream's `AgentEvent`
 * stream stays exactly as it is — one-way, observational, provider-normalised —
 * and carries none of this.
 */

import type {
  AgentContextBundle,
  AgentDefinition,
  ProjectId,
  SessionId,
} from '../../domain/src/index.js';

/** How an adapter reaches its executor. */
export const RuntimeKind = {
  /** Spawns the provider's CLI on this machine. */
  LOCAL_CLI: 'local_cli',
  /** Drives a terminal owned by the editor (upstream's VS Code path). */
  EDITOR_TERMINAL: 'editor_terminal',
  /** A runtime on another host that registered with the Control Plane. */
  REMOTE: 'remote',
} as const;
export type RuntimeKind = (typeof RuntimeKind)[keyof typeof RuntimeKind];

export interface RuntimeDescriptor {
  /** Stable id of this runtime host. Recorded on `AgentSession.runtimeId`. */
  id: string;
  kind: RuntimeKind;
  /** Provider ids this runtime can execute, e.g. ['claude']. */
  providers: readonly string[];
  /** Projects it may run work for. Empty = any. */
  projects: readonly ProjectId[];
}

export interface StartRunRequest {
  /** The Agent Office session this run belongs to. Canonical identity. */
  sessionId: SessionId;
  agent: AgentDefinition;
  context: AgentContextBundle;
  /** Working directory for the run. */
  cwd: string;
}

export interface StartRunResult {
  /**
   * The provider's own id for the run, when it has one. Optional: a provider
   * may not report one, and it is integration metadata either way — the caller
   * stores it via `bindExternalRuntime`, never as a key.
   */
  providerSessionId?: string;
  /** Provider transcript handle, when the provider keeps one. */
  transcriptPath?: string;
}

export interface RuntimeHealth {
  ok: boolean;
  detail?: string;
}

export interface AgentRuntimeAdapter {
  readonly descriptor: RuntimeDescriptor;

  /** Begin a run. Returns whatever external identity the provider exposed. */
  startRun(request: StartRunRequest): Promise<StartRunResult>;

  /**
   * Send further instruction into a live run. Needed by Manager Agent
   * orchestration in Milestone 8; declared here so the seam does not move.
   */
  sendMessage(sessionId: SessionId, text: string): Promise<void>;

  /** Stop a run. Idempotent: stopping an already-stopped run is not an error. */
  stopRun(sessionId: SessionId): Promise<void>;

  health(): Promise<RuntimeHealth>;
}

/**
 * The six verbs a remote runtime speaks to the Control Plane. Declared as names
 * now so Milestone 6's transport (WebSocket, runtime dials out) and Milestone 3's
 * HTTP surface agree on vocabulary from the start.
 */
export const RuntimeBridgeVerb = {
  REGISTER: 'register',
  HEARTBEAT: 'heartbeat',
  DISPATCH_TASK: 'dispatch_task',
  REPORT_STATUS: 'report_status',
  REPORT_PROGRESS: 'report_progress',
  SUBMIT_OUTPUT: 'submit_output',
} as const;
export type RuntimeBridgeVerb = (typeof RuntimeBridgeVerb)[keyof typeof RuntimeBridgeVerb];

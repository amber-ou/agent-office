/**
 * The call log — a read-only record of observed Claude Code subagent calls.
 *
 * This is deliberately NOT `AgentSession`/`Task`/`Project`: those model
 * Office's own dispatched work (ADR 005's project/agent boundary, a
 * `projectId` foreign key on every session). A call observed here may have
 * no Office project, no Office `AgentDefinition`, sometimes no resolvable
 * agent identity at all ("unrecognized") — inventing a project or an agent
 * row just to hold it would misrepresent what was actually observed. This is
 * an APPLICATION-level record, the same escape hatch `reviewNotes.ts` uses:
 * the frozen M1 domain needs no amendment, and the port lives here, beside
 * its adapter, rather than in `domain/src/repositories.ts`.
 *
 * Identity for dedup and lookup is `(parentSessionId, toolUseId)` — the
 * Claude session id the call was made from, plus the stable JSONL tool_use
 * id of the `Task` tool call that made it. Both come straight from the
 * transcript, never invented, so a repeated or late-arriving event for the
 * same call is a no-op rather than a duplicate row.
 */

import type { Timestamp } from '../../domain/src/index.js';

export type AgentCallStatus =
  | 'running'
  | 'waiting_response'
  | 'ended'
  | 'failed'
  /** Was open (running/waiting_response) when the server last shut down or
   *  lost the session, and no confirmed end event ever arrived. Never
   *  silently promoted to 'ended' — the shutdown moment is not a completion
   *  time (see spec: restart must not fabricate a done task). */
  | 'unknown';

export interface AgentCallUsage {
  /** Fresh (non-cached) prompt tokens summed over the call's turns. */
  inputTokens: number;
  outputTokens: number;
  /** Present only when the transcript reported it; kept separate from
   *  `inputTokens` so a caller can show accounting basis rather than a
   *  silently-merged total. */
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AgentCall {
  id: string;
  /** The `subagent_type` value the Task tool call carried. */
  agentName: string;
  /** Set once the name was matched, unambiguously, against the native agent
   *  roster (`discoverNativeAgents`). Absent for a built-in name (e.g.
   *  `general-purpose`) or a name no current roster file declares. */
  agentFilePath?: string;
  /** True only when `agentName` matched exactly one roster file. A caller
   *  must never guess an identity when this is false — show "未辨識 Agent". */
  recognized: boolean;
  parentSessionId: string;
  toolUseId: string;
  /** The Task tool's `prompt` input — the actual text handed to the agent. */
  taskText?: string;
  /** The Task tool's short `description` input. */
  taskDescription?: string;
  status: AgentCallStatus;
  /** Absent when observation began mid-call and no earlier start could be
   *  recovered — never backfilled from the observation moment. */
  startedAt?: Timestamp;
  startUnknown: boolean;
  /** Set only by a confirmed end event, or by the restart safety net (which
   *  sets status to 'unknown' and leaves this absent). */
  endedAt?: Timestamp;
  usage?: AgentCallUsage;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface StartAgentCallInput {
  agentName: string;
  agentFilePath?: string;
  recognized: boolean;
  parentSessionId: string;
  toolUseId: string;
  taskText?: string;
  taskDescription?: string;
  /** Absent when the call was already in progress at the moment it was
   *  first observed (see `AgentCall.startUnknown`). */
  startedAt?: Timestamp;
}

export interface EndAgentCallInput {
  parentSessionId: string;
  toolUseId: string;
  status: 'ended' | 'failed';
  endedAt: Timestamp;
}

export interface AgentCallLogStore {
  /**
   * Record a call's start. Idempotent on `(parentSessionId, toolUseId)`: a
   * repeated or replayed start event returns the existing row unchanged
   * rather than creating a second one or resetting its `startedAt`.
   */
  start(input: StartAgentCallInput): Promise<AgentCall>;

  /** Update status only (e.g. running -> waiting_response). No-op if the
   *  call is already in a terminal status (ended/failed/unknown) — a late
   *  status event must never resurrect a finished call. */
  markStatus(parentSessionId: string, toolUseId: string, status: AgentCallStatus): Promise<void>;

  /**
   * Record a confirmed end. Idempotent: a call already in a terminal status
   * keeps its original `endedAt` and status rather than overwriting them
   * with a later, redundant end event.
   */
  end(input: EndAgentCallInput): Promise<void>;

  /** Replace the usage figures for a call. Called at most once, when the
   *  call ends and its window's usage was unambiguous to attribute. */
  setUsage(parentSessionId: string, toolUseId: string, usage: AgentCallUsage): Promise<void>;

  /** Newest first. */
  listRecent(limit: number, offset?: number): Promise<AgentCall[]>;

  get(parentSessionId: string, toolUseId: string): Promise<AgentCall | null>;

  /**
   * Restart safety net: every call still `running`/`waiting_response` when
   * this is called (i.e. the process that was tracking it is gone) moves to
   * `unknown`. Returns how many rows changed. Never sets `endedAt` — the
   * restart moment is not evidence the call actually finished then.
   */
  markOpenCallsUnknown(): Promise<number>;
}

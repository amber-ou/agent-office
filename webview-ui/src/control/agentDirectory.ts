/**
 * Single source of truth for "what is this agent doing right now" —
 * combines the CC native-agent roster with the observed call log. Called
 * from `officeCharacters.ts` (the pixel character), `AgentPanel.tsx` (the
 * full list) and `AgentDetailPanel.tsx` (a single agent), so the three
 * views can never disagree about a status a caller only computed once,
 * differently, in each place.
 */

import type { AgentCallLogEntry, NativeAgentRosterEntry } from '../../../core/src/messages.js';

export type AgentStatus = 'idle' | 'working' | 'waiting_response' | 'unknown';

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: '待命',
  working: '工作中',
  waiting_response: '等待回應',
  unknown: '未知',
};

/** Calls whose real end this version cannot confirm — a fallback status of
 *  `unknown` beats a false `idle`, when one of these is the most recent
 *  thing known about the agent. */
const UNRESOLVED_TERMINAL_STATUSES: ReadonlySet<AgentCallLogEntry['status']> = new Set([
  'unknown',
  'background_not_tracked',
]);

/** `startedAt` is absent only when the start itself was never observed
 *  (`startUnknown`); `createdAt` (when the row was written) is always
 *  present and a reasonable fallback ordering key for that rare case. Both
 *  are ISO 8601, so lexicographic order is chronological order. */
function callRecency(call: AgentCallLogEntry): string {
  return call.startedAt ?? call.createdAt;
}

function sortByRecencyDesc(calls: readonly AgentCallLogEntry[]): AgentCallLogEntry[] {
  return [...calls].sort((a, b) => callRecency(b).localeCompare(callRecency(a)));
}

export interface AgentState {
  status: AgentStatus;
  /** The call explaining the current status. Absent for `idle` — there is
   *  nothing "current" to show. */
  currentCall?: AgentCallLogEntry;
}

/**
 * One agent's status from its own calls alone.
 *
 * Priority: any call still confirmed open outranks a stale unresolved one —
 * one of several concurrent calls finishing (or going untracked) must never
 * idle a character that has a sibling call still genuinely running. Only
 * when nothing is confirmed open does the single most recent call's own
 * terminal status decide: an unresolved one (`unknown` from a restart,
 * `background_not_tracked` from an async launch) reports `unknown` rather
 * than a confident `idle`, since neither this version nor a lost connection
 * actually confirmed the agent stopped.
 */
export function deriveAgentState(calls: readonly AgentCallLogEntry[]): AgentState {
  const sorted = sortByRecencyDesc(calls);
  const waiting = sorted.filter((call) => call.status === 'waiting_response');
  if (waiting.length > 0) return { status: 'waiting_response', currentCall: waiting[0] };
  const running = sorted.filter((call) => call.status === 'running');
  if (running.length > 0) return { status: 'working', currentCall: running[0] };
  if (sorted.length === 0) return { status: 'idle' };
  const latest = sorted[0]!;
  if (UNRESOLVED_TERMINAL_STATUSES.has(latest.status)) {
    return { status: 'unknown', currentCall: latest };
  }
  return { status: 'idle' };
}

export interface AgentSummary {
  /** Stable identity — the roster file path. */
  key: string;
  name: string;
  description: string;
  ambiguous: boolean;
  status: AgentStatus;
  currentCall?: AgentCallLogEntry;
  /** Every call recorded for this agent, newest first. */
  history: AgentCallLogEntry[];
  /** Whether this agent has ever been called at all — lets a caller say
   *  "尚未呼叫" for an agent that is idle because nothing ever ran, distinct
   *  from idle-with-history. */
  everCalled: boolean;
}

/**
 * One summary per roster entry. A call that never resolved to exactly one
 * roster file (`recognized: false`) is never attributed to any agent here —
 * it appears only in the flat call-history list, as "未辨識 Agent".
 */
export function computeAgentSummaries(
  roster: readonly NativeAgentRosterEntry[],
  calls: readonly AgentCallLogEntry[],
): AgentSummary[] {
  const callsByAgent = new Map<string, AgentCallLogEntry[]>();
  for (const call of calls) {
    if (!call.recognized || !call.agentFilePath) continue;
    const list = callsByAgent.get(call.agentFilePath) ?? [];
    list.push(call);
    callsByAgent.set(call.agentFilePath, list);
  }
  return roster.map((agent) => {
    const agentCalls = sortByRecencyDesc(callsByAgent.get(agent.filePath) ?? []);
    const { status, currentCall } = deriveAgentState(agentCalls);
    return {
      key: agent.filePath,
      name: agent.name,
      description: agent.description,
      ambiguous: agent.ambiguous,
      status,
      currentCall,
      history: agentCalls,
      everCalled: agentCalls.length > 0,
    };
  });
}

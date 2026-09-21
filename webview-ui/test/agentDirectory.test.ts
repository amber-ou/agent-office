import { describe, expect, it } from 'vitest';

import type {
  AgentCallLogEntry,
  AgentCallStatus,
  NativeAgentRosterEntry,
} from '../../core/src/messages.js';
import { computeAgentSummaries, deriveAgentState } from '../src/control/agentDirectory.js';

let nextId = 1;
function call(status: AgentCallStatus, patch: Partial<AgentCallLogEntry> = {}): AgentCallLogEntry {
  const n = nextId++;
  return {
    id: `call-${n}`,
    agentName: 'skill-retriever',
    agentFilePath: '/home/user/.claude/agents/skill-retriever.md',
    recognized: true,
    parentSessionId: 'session',
    toolUseId: `tool-${n}`,
    status,
    startUnknown: false,
    startedAt: `2026-09-21T00:0${n}:00Z`,
    createdAt: `2026-09-21T00:0${n}:00Z`,
    updatedAt: `2026-09-21T00:0${n}:00Z`,
    ...patch,
  };
}

describe('deriveAgentState', () => {
  it('is idle with no calls at all', () => {
    expect(deriveAgentState([])).toEqual({ status: 'idle' });
  });

  it('is idle when the only calls are terminal (ended/failed)', () => {
    const c = call('ended');
    expect(deriveAgentState([c])).toEqual({ status: 'idle' });
  });

  it('is working when a call is running', () => {
    const c = call('running');
    expect(deriveAgentState([c])).toEqual({ status: 'working', currentCall: c });
  });

  it('is waiting_response when a call is waiting_response, even alongside a running one', () => {
    const running = call('running');
    const waiting = call('waiting_response');
    expect(deriveAgentState([running, waiting])).toEqual({
      status: 'waiting_response',
      currentCall: waiting,
    });
  });

  it('reports unknown (not idle) when the most recent call is unknown (restart-recovered)', () => {
    const c = call('unknown');
    expect(deriveAgentState([c])).toEqual({ status: 'unknown', currentCall: c });
  });

  it('reports unknown (not idle) when the most recent call is background_not_tracked', () => {
    const c = call('background_not_tracked');
    expect(deriveAgentState([c])).toEqual({ status: 'unknown', currentCall: c });
  });

  it('one concurrent call finishing does not idle the agent while a sibling call is still running', () => {
    const ended = call('ended', { startedAt: '2026-09-21T00:01:00Z' });
    const running = call('running', { startedAt: '2026-09-21T00:02:00Z' });
    expect(deriveAgentState([ended, running])).toEqual({ status: 'working', currentCall: running });
  });

  it('an older unknown call does not override a newer, confidently-idle (ended) call', () => {
    const unknown = call('unknown', { startedAt: '2026-09-21T00:01:00Z' });
    const ended = call('ended', { startedAt: '2026-09-21T00:02:00Z' });
    expect(deriveAgentState([unknown, ended])).toEqual({ status: 'idle' });
  });
});

describe('computeAgentSummaries', () => {
  const retriever: NativeAgentRosterEntry = {
    name: 'skill-retriever',
    description: 'Finds skills.',
    filePath: '/home/user/.claude/agents/skill-retriever.md',
    ambiguous: false,
  };
  const writer: NativeAgentRosterEntry = {
    name: 'writer',
    description: '',
    filePath: '/home/user/.claude/agents/writer.md',
    ambiguous: false,
  };

  it('lists every roster agent even with zero call history', () => {
    const summaries = computeAgentSummaries([retriever, writer], []);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.status === 'idle' && !s.everCalled)).toBe(true);
  });

  it('never attributes an unrecognized call to any roster agent', () => {
    const unrecognized = call('running', { recognized: false, agentFilePath: undefined });
    const summaries = computeAgentSummaries([retriever], [unrecognized]);
    expect(summaries[0]!.status).toBe('idle');
    expect(summaries[0]!.everCalled).toBe(false);
  });

  it('attributes a recognized call only to its own agent', () => {
    const c = call('running');
    const summaries = computeAgentSummaries([retriever, writer], [c]);
    const retrieverSummary = summaries.find((s) => s.key === retriever.filePath)!;
    const writerSummary = summaries.find((s) => s.key === writer.filePath)!;
    expect(retrieverSummary.status).toBe('working');
    expect(retrieverSummary.everCalled).toBe(true);
    expect(writerSummary.status).toBe('idle');
    expect(writerSummary.everCalled).toBe(false);
  });

  it('keeps full history sorted newest first', () => {
    const older = call('ended', { startedAt: '2026-09-21T00:01:00Z' });
    const newer = call('ended', { startedAt: '2026-09-21T00:02:00Z' });
    const summaries = computeAgentSummaries([retriever], [older, newer]);
    expect(summaries[0]!.history.map((c) => c.id)).toEqual([newer.id, older.id]);
  });
});

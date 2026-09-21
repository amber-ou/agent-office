/**
 * Call-log capture in transcriptParser.ts: the observation points the CC
 * activity dashboard is built on (see docs/task-log.md). Two CLI-version
 * facts drive this file's cases, both taken from CLAUDE.md's own provider
 * table rather than assumed: the foreground subagent-delegation tool is
 * named `Task` on older builds and `Agent` on current ones, and an
 * Agent-tool spawn carrying a `name` field is a teammate-to-be, not a
 * bounded call, so it must be excluded here (the existing team mechanism
 * already tracks it as a persistent character).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type {
  TaskCallBackgroundInfo,
  TaskCallEndInfo,
  TaskCallStartInfo,
} from '../src/transcriptParser.js';
import {
  processTranscriptLine,
  setHookProvider,
  setTaskCallBackgroundCallback,
  setTaskCallEndedCallback,
  setTaskCallStartedCallback,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'parent-session-1',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function toolUseRecord(toolId: string, name: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResultRecord(toolId: string, text: string, isError = false) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          is_error: isError,
          content: [{ type: 'text', text }],
        },
      ],
    },
  });
}

describe('call-log capture', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let started: TaskCallStartInfo[];
  let ended: TaskCallEndInfo[];
  let background: TaskCallBackgroundInfo[];
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    started = [];
    ended = [];
    background = [];
    setTaskCallStartedCallback((info) => started.push(info));
    setTaskCallEndedCallback((info) => ended.push(info));
    setTaskCallBackgroundCallback((info) => background.push(info));
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
      setTaskCallStartedCallback(null);
      setTaskCallEndedCallback(null);
      setTaskCallBackgroundCallback(null);
    };
  });

  it("captures a 'Task' tool call (older CLI builds) with its subagent_type, prompt and description", () => {
    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Task', {
        subagent_type: 'skill-retriever',
        prompt: 'Find skills for authentication',
        description: 'Find skills',
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(started).toEqual([
      {
        agentId: 1,
        parentSessionId: 'parent-session-1',
        toolUseId: 'toolu_1',
        subagentType: 'skill-retriever',
        prompt: 'Find skills for authentication',
        description: 'Find skills',
      },
    ]);
  });

  it("captures an 'Agent' tool call (current CLI builds) the same way", () => {
    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', {
        subagent_type: 'skill-retriever',
        prompt: 'Find skills for authentication',
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.subagentType).toBe('skill-retriever');
  });

  it('does not capture an Agent spawn carrying a `name` (a teammate-to-be, not a bounded call)', () => {
    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', {
        name: 'wa-research',
        subagent_type: 'general-purpose',
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(started).toEqual([]);
  });

  it('ends a captured call on a normal tool_result, with isError from is_error', () => {
    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Found 3 relevant skills.'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(ended).toEqual([
      { agentId: 1, parentSessionId: 'parent-session-1', toolUseId: 'toolu_1', isError: false },
    ]);
    expect(background).toEqual([]);
  });

  it('marks a call background-not-tracked instead of ended when the result is an async launch acknowledgment', () => {
    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Async agent launched successfully. agentId: abc123'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    // Never both: an async launch ack must not also be reported as ended.
    expect(ended).toEqual([]);
    expect(background).toEqual([
      { agentId: 1, parentSessionId: 'parent-session-1', toolUseId: 'toolu_1' },
    ]);
  });

  it('reports isError=true for a failed call', () => {
    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Task', { subagent_type: 'skill-retriever' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Error: could not complete', true),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(ended).toEqual([
      { agentId: 1, parentSessionId: 'parent-session-1', toolUseId: 'toolu_1', isError: true },
    ]);
  });
});

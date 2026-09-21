/**
 * Integration test for the CC activity dashboard's one supported call path:
 * an observed transcript line → `installCallLogBridge` → the persisted
 * `agent_calls` row → the `agentCallUpdated` broadcast the webview's
 * `officeCharacters` engine and `TaskLogPanel` both consume. Not a full
 * e2e — no real Claude process, no browser — but it exercises the real
 * SQLite storage and the real native-agent roster resolution together,
 * which the pure-unit tests (`callLogCapture.test.ts`,
 * `storage/__tests__/callLog.test.ts`) each only half cover.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { installCallLogBridge } from '../src/callLogBridge.js';
import {
  closeOfficeStorage,
  getOfficeStorage,
  setClaudeDiscoveryPaths,
  setOfficeDataRoot,
} from '../src/control/officeStorage.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

let root: string;
let claudeAgentsRoot: string;

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-calllog-bridge-'));
  claudeAgentsRoot = path.join(root, 'claude', 'agents');
  fs.mkdirSync(claudeAgentsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(claudeAgentsRoot, 'skill-retriever.md'),
    '---\nname: skill-retriever\ndescription: Finds relevant skills.\n---\nBody.\n',
  );
  setOfficeDataRoot(root);
  setClaudeDiscoveryPaths({
    claudeAgentsRoot,
    claudeSkillsRoot: path.join(root, 'claude', 'skills'),
  });
  setHookProvider(claudeProvider);
});

afterEach(() => {
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  setClaudeDiscoveryPaths(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('call log bridge (transcript -> storage -> broadcast)', () => {
  it('records a recognized call, resolves its roster file, and broadcasts start then end', async () => {
    const store = new AgentStateStore();
    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (msg) => broadcasts.push(msg as Record<string, unknown>));
    installCallLogBridge(store);
    store.set(1, createTestAgent());
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', {
        subagent_type: 'skill-retriever',
        prompt: 'Find skills for authentication',
        description: 'Find skills',
      }),
      store,
      waitingTimers,
      permissionTimers,
    );

    // The bridge's storage write is async (fire-and-forget from
    // transcriptParser's synchronous callback); give its promise chain a
    // tick before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const storage = getOfficeStorage()!;
    const started = await storage.callLog.get('parent-session-1', 'toolu_1');
    expect(started).toMatchObject({
      agentName: 'skill-retriever',
      agentFilePath: path.join(claudeAgentsRoot, 'skill-retriever.md'),
      recognized: true,
      taskText: 'Find skills for authentication',
      taskDescription: 'Find skills',
      status: 'running',
      startUnknown: false,
    });
    expect(started?.endedAt).toBeUndefined();

    const startBroadcast = broadcasts.find(
      (m) =>
        m.type === 'agentCallUpdated' && (m.call as { toolUseId: string }).toolUseId === 'toolu_1',
    );
    expect(startBroadcast).toBeDefined();
    expect((startBroadcast!.call as { status: string }).status).toBe('running');

    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Found 3 relevant skills.'),
      store,
      waitingTimers,
      permissionTimers,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ended = await storage.callLog.get('parent-session-1', 'toolu_1');
    expect(ended?.status).toBe('ended');
    expect(ended?.endedAt).toBeDefined();

    const endBroadcasts = broadcasts.filter(
      (m) =>
        m.type === 'agentCallUpdated' && (m.call as { toolUseId: string }).toolUseId === 'toolu_1',
    );
    expect(endBroadcasts.at(-1)).toMatchObject({ call: { status: 'ended' } });
  });

  it('marks a call unrecognized when subagent_type matches no roster file, without guessing an identity', async () => {
    const store = new AgentStateStore();
    installCallLogBridge(store);
    store.set(1, createTestAgent());
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', { subagent_type: 'general-purpose' }),
      store,
      waitingTimers,
      permissionTimers,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = await getOfficeStorage()!.callLog.get('parent-session-1', 'toolu_1');
    expect(call?.recognized).toBe(false);
    expect(call?.agentFilePath).toBeUndefined();
  });

  it('marks a call background_not_tracked (never ended) when the result is an async launch acknowledgment', async () => {
    const store = new AgentStateStore();
    installCallLogBridge(store);
    store.set(1, createTestAgent());
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

    processTranscriptLine(
      1,
      toolUseRecord('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }),
      store,
      waitingTimers,
      permissionTimers,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Async agent launched successfully. agentId: abc123'),
      store,
      waitingTimers,
      permissionTimers,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = await getOfficeStorage()!.callLog.get('parent-session-1', 'toolu_1');
    expect(call?.status).toBe('background_not_tracked');
    expect(call?.endedAt).toBeUndefined();
  });
});

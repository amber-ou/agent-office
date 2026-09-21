/**
 * `AgentCallLogStore` — the observed-call persistence for the CC activity
 * dashboard. A sibling table to `tasks`/`agent_sessions`, never a reuse of
 * either (see `storage/src/callLog.ts`). Covers the minimal-acceptance
 * criteria from the task-log spec: dedup on replay, no resurrecting a
 * terminal call, and the restart safety net never fabricating an end time.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteStorage } from '../src/index.js';
import { openSqliteStorage } from '../src/index.js';

let dataRoot: string;
let storage: SqliteStorage;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-calllog-'));
  storage = openSqliteStorage({ dataRoot });
});

afterEach(() => {
  storage.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('SqliteAgentCallLogStore', () => {
  it('records a call start and reads it back', async () => {
    const call = await storage.callLog.start({
      agentName: 'skill-retriever',
      agentFilePath: '/home/user/.claude/agents/skill-retriever.md',
      recognized: true,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      taskText: 'Find skills for X',
      taskDescription: 'Find skills',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(call.status).toBe('running');
    expect(call.startUnknown).toBe(false);
    expect(call.recognized).toBe(true);
    expect(call.endedAt).toBeUndefined();

    const fetched = await storage.callLog.get('session-1', 'toolu_1');
    expect(fetched).toEqual(call);
  });

  it('is idempotent on (parentSessionId, toolUseId): a replayed start never duplicates or resets it', async () => {
    const first = await storage.callLog.start({
      agentName: 'skill-retriever',
      recognized: true,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    const second = await storage.callLog.start({
      agentName: 'skill-retriever',
      recognized: true,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      // A later, different observation must not overwrite the first.
      startedAt: '2026-01-01T00:05:00.000Z',
      taskText: 'a different task text',
    });
    expect(second).toEqual(first);
    const all = await storage.callLog.listRecent(10);
    expect(all).toHaveLength(1);
  });

  it('marks unrecognized calls without a resolved agent file', async () => {
    const call = await storage.callLog.start({
      agentName: 'general-purpose',
      recognized: false,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(call.recognized).toBe(false);
    expect(call.agentFilePath).toBeUndefined();
  });

  it('records start-time-unknown when no startedAt is given', async () => {
    const call = await storage.callLog.start({
      agentName: 'skill-retriever',
      recognized: true,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
    });
    expect(call.startUnknown).toBe(true);
    expect(call.startedAt).toBeUndefined();
  });

  it('ends a call and leaves a terminal call alone on a later, redundant end', async () => {
    await storage.callLog.start({
      agentName: 'skill-retriever',
      recognized: true,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.callLog.end({
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      status: 'ended',
      endedAt: '2026-01-01T00:05:00.000Z',
    });
    const ended = await storage.callLog.get('session-1', 'toolu_1');
    expect(ended?.status).toBe('ended');
    expect(ended?.endedAt).toBe('2026-01-01T00:05:00.000Z');

    // A late/duplicate end (e.g. a replayed tool_result) must not flip an
    // already-ended call to failed, or move its endedAt.
    await storage.callLog.end({
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      status: 'failed',
      endedAt: '2026-01-01T00:10:00.000Z',
    });
    const stillEnded = await storage.callLog.get('session-1', 'toolu_1');
    expect(stillEnded?.status).toBe('ended');
    expect(stillEnded?.endedAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('never resurrects a terminal call via markStatus', async () => {
    await storage.callLog.start({
      agentName: 'skill-retriever',
      recognized: true,
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.callLog.end({
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      status: 'failed',
      endedAt: '2026-01-01T00:05:00.000Z',
    });
    await storage.callLog.markStatus('session-1', 'toolu_1', 'running');
    const call = await storage.callLog.get('session-1', 'toolu_1');
    expect(call?.status).toBe('failed');
  });

  it('lists calls newest first', async () => {
    await storage.callLog.start({
      agentName: 'a',
      recognized: false,
      parentSessionId: 's',
      toolUseId: 't1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.callLog.start({
      agentName: 'b',
      recognized: false,
      parentSessionId: 's',
      toolUseId: 't2',
      startedAt: '2026-01-01T00:05:00.000Z',
    });
    const recent = await storage.callLog.listRecent(10);
    expect(recent.map((c) => c.toolUseId)).toEqual(['t2', 't1']);
  });

  it('restart safety net: flips open calls to unknown without fabricating an end time', async () => {
    await storage.callLog.start({
      agentName: 'a',
      recognized: false,
      parentSessionId: 's',
      toolUseId: 't1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.callLog.start({
      agentName: 'b',
      recognized: false,
      parentSessionId: 's',
      toolUseId: 't2',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.callLog.end({
      parentSessionId: 's',
      toolUseId: 't2',
      status: 'ended',
      endedAt: '2026-01-01T00:05:00.000Z',
    });

    const changed = await storage.callLog.markOpenCallsUnknown();
    expect(changed).toBe(1);

    const open = await storage.callLog.get('s', 't1');
    expect(open?.status).toBe('unknown');
    expect(open?.endedAt).toBeUndefined();

    // Already-terminal calls are untouched.
    const alreadyEnded = await storage.callLog.get('s', 't2');
    expect(alreadyEnded?.status).toBe('ended');
  });

  it('sets usage figures for a call', async () => {
    await storage.callLog.start({
      agentName: 'a',
      recognized: true,
      parentSessionId: 's',
      toolUseId: 't1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.callLog.setUsage('s', 't1', {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
    });
    const call = await storage.callLog.get('s', 't1');
    expect(call?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
    });
  });
});

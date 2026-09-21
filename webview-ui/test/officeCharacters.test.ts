import { describe, expect, it } from 'vitest';

import type {
  AgentCallLogEntry,
  AgentCallStatus,
  NativeAgentRoster,
  NativeAgentRosterEntry,
} from '../../core/src/messages.js';
import { OfficeCharacters } from '../src/office/engine/officeCharacters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { TileType } from '../src/office/types.js';

const rosterEntry = (
  name: string,
  patch: Partial<NativeAgentRosterEntry> = {},
): NativeAgentRosterEntry => ({
  name,
  description: '',
  filePath: `/home/user/.claude/agents/${name}.md`,
  ambiguous: false,
  ...patch,
});

const roster = (agents: NativeAgentRosterEntry[]): NativeAgentRoster => ({
  type: 'nativeAgentRoster',
  agents,
  root: '/home/user/.claude/agents',
});

let nextCallId = 1;
const call = (
  agentEntry: NativeAgentRosterEntry,
  status: AgentCallStatus,
  patch: Partial<AgentCallLogEntry> = {},
): AgentCallLogEntry => ({
  id: `call-${nextCallId++}`,
  agentName: agentEntry.name,
  agentFilePath: agentEntry.filePath,
  recognized: true,
  parentSessionId: 'parent-session',
  toolUseId: `tool-${nextCallId}`,
  status,
  startUnknown: false,
  startedAt: '2026-09-21T00:00:00Z',
  createdAt: '2026-09-21T00:00:00Z',
  updatedAt: '2026-09-21T00:00:00Z',
  ...patch,
});

function scene() {
  return new OfficeState({
    version: 1,
    cols: 9,
    rows: 7,
    tiles: Array(63).fill(TileType.FLOOR_1),
    furniture: [],
  });
}

describe('Office residents are sourced from the CC native-agent roster', () => {
  it('waits for the layout, then creates a named idle character with no call', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    expect(residents.sync(os, false)).toEqual([]);
    expect(os.characters.size).toBe(0);

    const [id] = residents.sync(os, true);
    const ch = os.characters.get(id)!;
    expect(ch.agentName).toBe('skill-retriever');
    expect(ch.officeStatus).toBe('idle');
    expect(ch.isActive).toBe(false);
  });

  it('keeps the same character for the same agent across a roster refresh (no duplicate resident)', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    const [firstId] = residents.sync(os, true);

    // A later roster re-scan (e.g. after a file-watch tick) describes the
    // same file again — must resolve to the SAME character, not a new one.
    residents.receive(roster([rosterEntry('skill-retriever')]));
    const [secondId] = residents.sync(os, true);
    expect(secondId).toBe(firstId);
    expect(os.characters.size).toBe(1);
  });

  it('removes the character when its agent leaves the roster, and re-adds it with the same id if it returns', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const writer = rosterEntry('writer');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever, writer]));
    const ids = residents.sync(os, true);
    expect(ids).toHaveLength(2);

    residents.receive(roster([writer]));
    const afterRemoval = residents.sync(os, true);
    expect(afterRemoval).toHaveLength(1);
    expect(os.characters.has(ids[0]!)).toBe(false);

    residents.receive(roster([retriever, writer]));
    const restored = residents.sync(os, true);
    expect(restored.sort()).toEqual(ids.sort());
  });

  it('a recognized running call marks the character working; ending it returns it to idle', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    const [id] = residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('idle');

    const running = call(retriever, 'running');
    residents.receive({ type: 'agentCallUpdated', call: running });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('working');
    expect(os.characters.get(id)?.isActive).toBe(true);

    residents.receive({ type: 'agentCallUpdated', call: { ...running, status: 'ended' } });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('idle');
    expect(os.characters.get(id)?.isActive).toBe(false);
  });

  it('an unrecognized call never creates or activates any character', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    const [id] = residents.sync(os, true);

    residents.receive({
      type: 'agentCallUpdated',
      call: call(retriever, 'running', {
        agentName: 'general-purpose',
        agentFilePath: undefined,
        recognized: false,
      }),
    });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('idle');
    expect(os.characters.size).toBe(1);
  });

  it('one of several concurrent calls ending does not idle the character while a sibling call is still open', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    const [id] = residents.sync(os, true);

    const callA = call(retriever, 'running', { toolUseId: 'tool-a' });
    const callB = call(retriever, 'running', { toolUseId: 'tool-b' });
    residents.receive({ type: 'agentCallUpdated', call: callA });
    residents.receive({ type: 'agentCallUpdated', call: callB });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('working');

    residents.receive({ type: 'agentCallUpdated', call: { ...callA, status: 'ended' } });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('working');

    residents.receive({ type: 'agentCallUpdated', call: { ...callB, status: 'ended' } });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('idle');
  });

  it('shows unknown (not idle) when the most recent call is background_not_tracked or restart-unknown', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    const [id] = residents.sync(os, true);

    residents.receive({
      type: 'agentCallUpdated',
      call: call(retriever, 'background_not_tracked'),
    });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('unknown');
    // 'unknown' never plays the working animation: it's not a confirmed idle
    // OR a confirmed still-running state.
    expect(os.characters.get(id)?.isActive).toBe(false);
  });

  it('a full snapshot replaces prior call state (e.g. after a reconnect)', () => {
    const os = scene();
    const retriever = rosterEntry('skill-retriever');
    const residents = new OfficeCharacters();
    residents.receive(roster([retriever]));
    const [id] = residents.sync(os, true);

    residents.receive({ type: 'agentCallUpdated', call: call(retriever, 'running') });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('working');

    // Reconnect: the server resends the snapshot, and this time nothing is open.
    residents.receive({ type: 'agentCallLogSnapshot', calls: [] });
    residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('idle');
  });
});

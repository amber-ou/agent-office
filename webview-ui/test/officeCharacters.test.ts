import { describe, expect, it } from 'vitest';

import type {
  OfficeAgent,
  OfficeSession,
  OfficeState as Snapshot,
  OfficeTask,
} from '../../core/src/messages.js';
import { OfficeCharacters, officeCharacterStatus } from '../src/office/engine/officeCharacters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { Direction, TileType } from '../src/office/types.js';

const date = '2026-09-21T00:00:00Z';
const agent = (id: string): OfficeAgent => ({
  id,
  name: id,
  role: 'retriever',
  description: '',
  provider: 'claude',
  createdAt: date,
  updatedAt: date,
});
const session = (patch: Partial<OfficeSession> = {}): OfficeSession => ({
  id: 'run-1',
  agentId: 'retriever',
  projectId: 'project',
  provider: 'claude',
  status: 'running',
  startedAt: date,
  ...patch,
});
const task = (status: string, patch: Partial<OfficeTask> = {}): OfficeTask => ({
  id: 'task',
  projectId: 'project',
  title: 'Read',
  description: '',
  assignedAgentId: 'retriever',
  status,
  priority: 'normal',
  dependencies: [],
  inputs: [],
  createdAt: date,
  updatedAt: date,
  ...patch,
});
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  type: 'officeState',
  storage: { ready: true, schemaVersion: 1 },
  projects: [],
  agents: [agent('retriever')],
  memberships: [{ id: 'member', projectId: 'project', agentId: 'retriever' }],
  tasks: [],
  sessions: [],
  activeProjectId: 'project',
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

describe('Office residents use the existing character engine', () => {
  it('waits for the layout, then creates a named idle character without a runtime session', () => {
    const os = scene();
    const residents = new OfficeCharacters();
    residents.receive(snapshot());
    expect(residents.sync(os, false)).toEqual([]);
    expect(os.characters.size).toBe(0);
    const [id] = residents.sync(os, true);
    const ch = os.characters.get(id)!;
    expect(ch.agentName).toBe('retriever');
    expect(ch.officeStatus).toBe('idle');
    expect(ch.isActive).toBe(false);
    expect(os.getPersistableSeats()).toEqual({});
    ch.x = 35;
    residents.receive(snapshot());
    expect(residents.sync(os, true)).toEqual([id]);
    expect(os.characters.get(id)).toBe(ch);
    expect(ch.x).toBe(35);
    const restarted = scene();
    const restored = new OfficeCharacters();
    restored.receive(snapshot({ activeProjectId: undefined }));
    expect(restored.sync(restarted, true)).toEqual([id]);
    expect(restarted.characters.get(id)?.palette).toBe(ch.palette);
  });

  it('filters by project membership, removes absent members, and restores the library', () => {
    const os = scene();
    const residents = new OfficeCharacters();
    residents.receive(snapshot({ agents: [agent('retriever'), agent('writer')] }));
    const [id] = residents.sync(os, true);
    residents.receive(snapshot({ activeProjectId: 'empty', memberships: [] }));
    expect(residents.sync(os, true)).toEqual([]);
    expect(os.characters.has(id)).toBe(false);
    residents.receive(
      snapshot({ activeProjectId: undefined, agents: [agent('retriever'), agent('writer')] }),
    );
    expect(residents.sync(os, true)).toHaveLength(2);
    residents.receive(snapshot({ storage: { ready: false, schemaVersion: 1 } }));
    expect(residents.sync(os, true)).toEqual([]);
    expect(os.getCharacters()).toEqual([]);
  });

  it.each(['snapshot-first', 'runtime-first', 'reconnect'])(
    'deduplicates by session identity (%s), frees seats, and preserves unrelated sessions',
    (order) => {
      const os = scene();
      const residents = new OfficeCharacters();
      os.addAgent(1);
      os.addAgent(2);
      os.seats.set('desk', {
        uid: 'desk',
        seatCol: 2,
        seatRow: 2,
        facingDir: Direction.DOWN,
        assigned: true,
      });
      os.characters.get(1)!.seatId = 'desk';
      const ready = snapshot({
        sessions: [session({ providerSessionId: 'provider-run' })],
        tasks: [task('in_progress')],
      });
      const runtime =
        order === 'reconnect'
          ? {
              type: 'existingAgents' as const,
              agents: [1, 2],
              folderNames: {},
              externalAgents: {},
              agentMeta: { 1: { palette: 0, hueShift: 0, sessionId: 'provider-run' } },
            }
          : { type: 'agentCreated' as const, id: 1, sessionId: 'provider-run' };
      residents.receive(order === 'snapshot-first' ? ready : runtime);
      residents.sync(os, true);
      residents.receive(order === 'snapshot-first' ? runtime : ready);
      const [id] = residents.sync(os, true);
      expect(
        os
          .getCharacters()
          .map((ch) => ch.id)
          .sort(),
      ).toEqual([id, 2].sort());
      expect(os.characters.get(1)?.seatId).toBeNull();
      expect(os.characters.get(id)?.officeStatus).toBe('working');
      expect(Object.keys(os.getPersistableSeats())).toEqual(['2']);
      os.setAgentTool(1, 'Read');
      residents.sync(os, true);
      expect(os.characters.get(id)?.currentTool).toBe('Read');
      os.showPermissionBubble(1);
      residents.sync(os, true);
      expect(os.characters.get(id)?.officeStatus).toBe('waiting');
      residents.receive(snapshot({ sessions: ready.sessions, tasks: [task('review')] }));
      residents.sync(os, true);
      expect(os.characters.get(id)?.officeStatus).toBe('review');
      expect(os.characters.get(id)?.isActive).toBe(false);
      residents.receive({ type: 'agentClosed', id: 1 });
      os.removeAgent(1);
      residents.sync(os, true);
      expect(os.characters.has(id)).toBe(true);
    },
  );

  it('does not match names, other providers, or ambiguous session ownership', () => {
    const os = scene();
    const residents = new OfficeCharacters();
    os.addAgent(1);
    os.characters.get(1)!.agentName = 'retriever';
    residents.receive({ type: 'agentCreated', id: 1, sessionId: 'run-1' });
    for (const sessions of [
      [],
      [session({ provider: 'other' })],
      [session(), session({ agentId: 'writer' })],
    ]) {
      residents.receive(snapshot({ sessions }));
      residents.sync(os, true);
      expect(os.getCharacters().some((ch) => ch.id === 1)).toBe(true);
    }
  });

  it('uses the latest run, so old permission bubbles cannot block new work', () => {
    const os = scene();
    const residents = new OfficeCharacters();
    for (const id of [1, 2]) {
      os.addAgent(id);
      residents.receive({ type: 'agentCreated', id, sessionId: `run-${id}` });
    }
    os.showPermissionBubble(1);
    os.setAgentTool(2, 'Read');
    residents.receive(
      snapshot({
        sessions: [session(), session({ id: 'run-2', startedAt: '2026-09-21T01:00:00Z' })],
        tasks: [task('in_progress')],
      }),
    );
    const [id] = residents.sync(os, true);
    expect(os.characters.get(id)?.officeStatus).toBe('working');
    expect(os.characters.get(id)?.currentTool).toBe('Read');
  });

  it.each([
    ['in_progress', 'working'],
    ['review', 'review'],
    ['blocked', 'blocked'],
    ['failed', 'error'],
    ['done', 'idle'],
  ])('projects task %s as %s even if the transcript still runs', (input, output) => {
    expect(officeCharacterStatus([task(input)], [session()])).toBe(output);
  });

  it('does not let newly queued work hide an active task', () => {
    expect(
      officeCharacterStatus(
        [task('in_progress'), task('review', { updatedAt: '2026-09-22T00:00:00Z' })],
        [],
      ),
    ).toBe('working');
    expect(
      officeCharacterStatus(
        [task('in_progress'), task('todo', { updatedAt: '2026-09-22T00:00:00Z' })],
        [],
      ),
    ).toBe('working');
  });
});

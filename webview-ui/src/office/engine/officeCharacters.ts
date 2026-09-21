import type {
  OfficeSession,
  OfficeState as Snapshot,
  OfficeTask,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type { OfficeState } from './officeState.js';

export type OfficeCharacterStatus = 'idle' | 'working' | 'review' | 'blocked' | 'error' | 'waiting';

export const OFFICE_CHARACTER_LABELS: Record<OfficeCharacterStatus, string> = {
  idle: '待命',
  working: '工作中',
  review: '等待審核',
  blocked: '受阻',
  error: '執行失敗',
  waiting: '等待回應',
};

function hashId(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** Task state takes precedence over a transcript that may still look active. */
export function officeCharacterStatus(
  tasks: OfficeTask[],
  sessions: OfficeSession[],
): OfficeCharacterStatus {
  const priority = (task: OfficeTask) =>
    task.status === 'in_progress'
      ? 3
      : task.status === 'review'
        ? 2
        : task.status === 'blocked'
          ? 1
          : 0;
  const task = [...tasks].sort(
    (a, b) => priority(b) - priority(a) || b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  if (task) {
    if (task.status === 'failed') return 'error';
    if (task.status === 'blocked') return 'blocked';
    if (task.status === 'review') return 'review';
    if (task.status === 'in_progress') return 'working';
    return 'idle';
  }
  const session = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (session?.status === 'running' || session?.status === 'starting') return 'working';
  return 'idle';
}

/** Projects provide residents; observed Claude sessions provide live activity.
 * This is presentation state only: creating a character never launches a model.
 */
export class OfficeCharacters {
  private snapshot: Snapshot | undefined;
  private readonly ids = new Map<string, number>();
  private readonly runtimeSessions = new Map<number, string>();

  receive(message: ServerMessage): void {
    if (message.type === 'officeState') this.snapshot = message;
    if (message.type === 'agentCreated' && message.sessionId) {
      this.runtimeSessions.set(message.id, message.sessionId);
    }
    if (message.type === 'existingAgents') {
      this.runtimeSessions.clear();
      for (const id of message.agents) {
        const sessionId = message.agentMeta[id]?.sessionId;
        if (sessionId) this.runtimeSessions.set(id, sessionId);
      }
    }
    if (message.type === 'agentClosed') this.runtimeSessions.delete(message.id);
  }

  sync(os: OfficeState, layoutReady: boolean): number[] {
    const snapshot = this.snapshot;
    if (!snapshot || !layoutReady) return [];
    const members = new Set(snapshot.memberships.map((member) => member.agentId));
    // With no project selected, show the global library (also after a restart).
    const agents = snapshot.storage.ready
      ? snapshot.agents.filter((agent) => !snapshot.activeProjectId || members.has(agent.id))
      : [];
    const wanted = new Set(agents.map((agent) => agent.id));
    const sessions = snapshot.sessions ?? [];
    const owners = new Map<string, Set<string>>();
    for (const session of sessions) {
      if (session.provider !== 'claude') continue;
      for (const key of new Set(
        [session.id, session.providerSessionId].filter((id): id is string => !!id),
      )) {
        const values = owners.get(key) ?? new Set<string>();
        values.add(session.agentId);
        owners.set(key, values);
      }
    }
    for (const [id, sessionId] of this.runtimeSessions) {
      const matches = owners.get(sessionId);
      // Never guess by name, folder, or an ambiguous provider session.
      const owner = matches?.size === 1 ? [...matches][0] : undefined;
      os.setOfficeSuppressed(id, owner !== undefined);
    }
    for (const ch of [...os.characters.values()]) {
      if (ch.officeAgentId && !wanted.has(ch.officeAgentId)) {
        os.removeAgent(ch.id);
        os.characters.delete(ch.id);
      }
    }
    const result: number[] = [];
    for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
      let id = this.ids.get(agent.id);
      if (id === undefined) {
        // Separate from positive runtime ids, small negative subagents and greeter.
        id = -10_000_000_000 - hashId(agent.id);
        while ([...this.ids.values()].includes(id) || os.characters.has(id)) id--;
        this.ids.set(agent.id, id);
      }
      const palette = hashId(agent.id) % Math.max(1, getLoadedCharacterCount());
      os.addAgent(
        id,
        palette,
        0,
        snapshot.memberships.find((member) => member.agentId === agent.id)?.seatId,
      );
      const ch = os.characters.get(id)!;
      ch.officeAgentId = agent.id;
      ch.agentName = agent.name;
      const tasks = snapshot.tasks.filter((task) => task.assignedAgentId === agent.id);
      const agentSessions = sessions.filter(
        (session) =>
          session.agentId === agent.id &&
          (!snapshot.activeProjectId || session.projectId === snapshot.activeProjectId),
      );
      const status = officeCharacterStatus(tasks, agentSessions);
      // Prefer the latest run, never a stale transcript from a previous task.
      const latest = [...agentSessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      const live =
        latest &&
        [...this.runtimeSessions].find(
          ([, sessionId]) =>
            owners.get(sessionId)?.size === 1 &&
            (sessionId === latest.id || sessionId === latest.providerSessionId),
        );
      const observed = live ? os.characters.get(live[0]) : undefined;
      ch.officeStatus =
        status === 'working' &&
        (observed?.bubbleType === 'permission' ||
          (observed?.waitingAwaitingInput && observed.bubbleType === 'waiting'))
          ? 'waiting'
          : status;
      const active = ch.officeStatus === 'working';
      if (ch.isActive !== active) os.setAgentActive(id, active);
      os.setAgentTool(id, active ? (observed?.currentTool ?? null) : null);
      if (ch.officeStatus === 'waiting' && observed?.bubbleType === 'permission')
        os.showPermissionBubble(id);
      else if (ch.officeStatus === 'review' || ch.officeStatus === 'waiting') {
        if (ch.bubbleType !== 'waiting') os.showWaitingBubble(id, true);
      } else ch.bubbleType = null;
      if (observed) os.setAgentContext(id, observed.contextTokens, observed.maxContextTokens);
      result.push(id);
    }
    return result;
  }
}

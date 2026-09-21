import type {
  AgentCallLogEntry,
  NativeAgentRosterEntry,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type { OfficeState } from './officeState.js';

export type OfficeCharacterStatus = 'idle' | 'working';

export const OFFICE_CHARACTER_LABELS: Record<OfficeCharacterStatus, string> = {
  idle: '待命',
  working: '工作中',
};

function hashId(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** A call still occupying its agent — the character stays 'working' while
 *  any of these exist for it, and one call ending must never flip a
 *  character idle while a sibling concurrent call is still open. */
const OPEN_CALL_STATUSES: ReadonlySet<AgentCallLogEntry['status']> = new Set([
  'running',
  'waiting_response',
]);

/**
 * Persistent characters sourced from the CC-native agent roster
 * (`~/.claude/agents`), independent of any Office Project/AgentDefinition —
 * see docs/task-log.md. CC is the sole authority on which agents exist;
 * Office only observes.
 *
 * Live activity comes from observed calls (`agentCallLogSnapshot` /
 * `agentCallUpdated`), keyed by the call's resolved `agentFilePath`. A call
 * that could not be matched to exactly one roster file (`recognized: false`)
 * never creates or activates a character — it appears only in the read-only
 * call list as "未辨識 Agent" (see TaskLogPanel). Creating or idling a
 * character never launches a model.
 */
export class OfficeCharacters {
  private roster: NativeAgentRosterEntry[] = [];
  /** agentFilePath -> set of currently-open call ids for that agent. Several
   *  concurrent calls to one agent are tracked individually so one ending
   *  never idles the character while a sibling call is still running. */
  private readonly openCallsByAgent = new Map<string, Set<string>>();
  /** agentFilePath -> stable negative character id, so the same agent never
   *  gets a second character across roster refreshes or call updates. */
  private readonly ids = new Map<string, number>();

  receive(message: ServerMessage): void {
    if (message.type === 'nativeAgentRoster') {
      this.roster = message.agents;
    } else if (message.type === 'agentCallLogSnapshot') {
      this.openCallsByAgent.clear();
      for (const call of message.calls) this.applyCall(call);
    } else if (message.type === 'agentCallUpdated') {
      this.applyCall(message.call);
    }
  }

  private applyCall(call: AgentCallLogEntry): void {
    if (!call.recognized || !call.agentFilePath) return;
    const open = this.openCallsByAgent.get(call.agentFilePath) ?? new Set<string>();
    if (OPEN_CALL_STATUSES.has(call.status)) {
      open.add(call.id);
    } else {
      open.delete(call.id);
    }
    this.openCallsByAgent.set(call.agentFilePath, open);
  }

  sync(os: OfficeState, layoutReady: boolean): number[] {
    if (!layoutReady) return [];
    const wanted = new Set(this.roster.map((agent) => agent.filePath));
    for (const ch of [...os.characters.values()]) {
      if (ch.officeAgentId && !wanted.has(ch.officeAgentId)) {
        os.removeAgent(ch.id);
        os.characters.delete(ch.id);
      }
    }
    const result: number[] = [];
    for (const agent of [...this.roster].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      let id = this.ids.get(agent.filePath);
      if (id === undefined) {
        // Separate from positive runtime ids, small negative subagents and greeter.
        id = -10_000_000_000 - hashId(agent.filePath);
        while ([...this.ids.values()].includes(id) || os.characters.has(id)) id--;
        this.ids.set(agent.filePath, id);
      }
      const palette = hashId(agent.filePath) % Math.max(1, getLoadedCharacterCount());
      os.addAgent(id, palette, 0);
      const ch = os.characters.get(id)!;
      ch.officeAgentId = agent.filePath;
      ch.agentName = agent.name;
      const openCount = this.openCallsByAgent.get(agent.filePath)?.size ?? 0;
      const status: OfficeCharacterStatus = openCount > 0 ? 'working' : 'idle';
      ch.officeStatus = status;
      const active = status === 'working';
      if (ch.isActive !== active) os.setAgentActive(id, active);
      os.setAgentTool(id, null);
      ch.bubbleType = null;
      result.push(id);
    }
    return result;
  }
}

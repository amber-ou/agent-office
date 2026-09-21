import type {
  AgentCallLogEntry,
  NativeAgentRosterEntry,
  ServerMessage,
} from '../../../../core/src/messages.js';
import type { AgentStatus } from '../../control/agentDirectory.js';
import { AGENT_STATUS_LABELS, deriveAgentState } from '../../control/agentDirectory.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type { OfficeState } from './officeState.js';

export type OfficeCharacterStatus = AgentStatus;
export const OFFICE_CHARACTER_LABELS = AGENT_STATUS_LABELS;

function hashId(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/**
 * Persistent characters sourced from the CC-native agent roster
 * (`~/.claude/agents`), independent of any Office Project/AgentDefinition —
 * see docs/task-log.md. CC is the sole authority on which agents exist;
 * Office only observes.
 *
 * Status for each character comes from `deriveAgentState` in
 * `control/agentDirectory.ts` — the exact function `AgentPanel.tsx` and
 * `AgentDetailPanel.tsx` also call, so a character can never show a status
 * the panel or a detail view would disagree with. A call that could not be
 * matched to exactly one roster file (`recognized: false`) never creates or
 * activates a character — it appears only in the read-only call list as
 * "未辨識 Agent" (see AgentPanel). Creating or idling a character never
 * launches a model.
 */
export class OfficeCharacters {
  private roster: NativeAgentRosterEntry[] = [];
  /** agentFilePath -> (callId -> call). Full call objects, not just open
   *  ids, so status derivation (including the "most recent call was
   *  unresolved" fallback to `unknown`) is the same computation the panel
   *  and detail view use — never a second, possibly-diverging one here. */
  private readonly callsByAgent = new Map<string, Map<string, AgentCallLogEntry>>();
  /** agentFilePath -> stable negative character id, so the same agent never
   *  gets a second character across roster refreshes or call updates. */
  private readonly ids = new Map<string, number>();

  receive(message: ServerMessage): void {
    if (message.type === 'nativeAgentRoster') {
      this.roster = message.agents;
    } else if (message.type === 'agentCallLogSnapshot') {
      this.callsByAgent.clear();
      for (const call of message.calls) this.applyCall(call);
    } else if (message.type === 'agentCallUpdated') {
      this.applyCall(message.call);
    }
  }

  private applyCall(call: AgentCallLogEntry): void {
    if (!call.recognized || !call.agentFilePath) return;
    const calls = this.callsByAgent.get(call.agentFilePath) ?? new Map<string, AgentCallLogEntry>();
    calls.set(call.id, call);
    this.callsByAgent.set(call.agentFilePath, calls);
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
      const calls = [...(this.callsByAgent.get(agent.filePath)?.values() ?? [])];
      const { status } = deriveAgentState(calls);
      ch.officeStatus = status;
      // 'unknown' never plays the working animation: this version does not
      // actually know the agent is still busy, and faking it would be the
      // same false confidence the status itself refuses to give.
      const active = status === 'working' || status === 'waiting_response';
      if (ch.isActive !== active) os.setAgentActive(id, active);
      os.setAgentTool(id, null);
      ch.bubbleType = null;
      result.push(id);
    }
    return result;
  }
}

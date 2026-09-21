/**
 * The Agent panel — the integrated, read-only entry point for every CC
 * native agent Office knows about, plus its observed call history.
 *
 * Replaces the old Office admin/dispatch surface: there is no create/edit
 * form and no Run/Accept/Request-changes control here. Office observes what
 * Claude Code actually did — a native agent's roster entry, and the calls
 * made to it — and shows it. See docs/task-log.md for the observation model
 * and its known limits (only within-conversation `Task`/`Agent` tool
 * delegation is captured in this version; a separately-launched
 * `claude --agent X` session cannot be tied back to an agent name today).
 */

import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { AGENT_STATUS_LABELS } from './agentDirectory.js';
import {
  agentLabel,
  CALL_STATUS_LABELS,
  durationLabel,
  formatTimestamp,
  truncate,
} from './callLogFormat.js';
import { useAgentDirectory } from './useAgentDirectory.js';

interface AgentPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens AgentDetailPanel for one agent — the same entry point a
   *  character click uses, so a row here and a character always lead to
   *  the identical view. */
  onSelectAgent: (agentKey: string) => void;
}

const rowClass = 'border-b border-border last:border-0';
const cellClass = 'py-3 px-4 align-top text-sm';
const headClass = 'py-2 px-4 text-left text-text-muted text-xs uppercase tracking-wide';

export function AgentPanel({ isOpen, onClose, onSelectAgent }: AgentPanelProps) {
  const { agents, calls, rosterLoaded, scanRoot, connectionState } = useAgentDirectory();
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Live-updating duration for any agent or call currently working — a
  // render tick only, never a per-second database write (see spec:
  // 執行時長規則).
  useEffect(() => {
    if (!isOpen) return;
    const hasOpenWork =
      agents.some((a) => a.status === 'working' || a.status === 'waiting_response') ||
      calls.some((call) => call.status === 'running');
    if (!hasOpenWork) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOpen, agents, calls]);

  if (!isOpen) {
    return null;
  }

  const disconnected = connectionState !== 'connected';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Agent" className="w-256 max-w-[92vw]">
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
        <p className="text-text-muted text-sm px-4">
          Claude Code 建立與維護的 Agent，Office 只觀測與顯示。Agent 的建立、修改與派工請在 Claude
          Code 進行。
        </p>

        {disconnected && rosterLoaded && agents.length > 0 && (
          <p className="text-warning text-sm px-4">連線中斷，以下為最後已知狀態。</p>
        )}

        {disconnected && !rosterLoaded ? (
          <p className="text-warning text-sm px-4 py-6">連線中斷，尚未取得 Agent 名單。</p>
        ) : !rosterLoaded ? (
          <p className="text-text-muted text-sm px-4 py-6">讀取中…</p>
        ) : agents.length === 0 ? (
          <p className="text-text-muted text-sm px-4 py-6">
            尚未找到 CC Agent。掃描位置：{scanRoot ?? '—'}
          </p>
        ) : (
          <>
            <section>
              <h3 className="text-accent-bright text-lg px-4 mb-2">Agent 狀態</h3>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b-2 border-border">
                    <th className={headClass}>名稱</th>
                    <th className={headClass}>狀態</th>
                    <th className={headClass}>目前任務</th>
                    <th className={headClass}>執行時長</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr
                      key={agent.key}
                      className={`${rowClass} cursor-pointer hover:bg-btn-bg`}
                      onClick={() => onSelectAgent(agent.key)}
                    >
                      <td className={cellClass}>
                        {agent.name}
                        {agent.ambiguous && (
                          <span className="text-warning text-xs"> （名稱衝突）</span>
                        )}
                      </td>
                      <td className={cellClass}>{AGENT_STATUS_LABELS[agent.status]}</td>
                      <td className={cellClass}>
                        {agent.status === 'idle' || !agent.currentCall ? (
                          <span className="text-text-muted">
                            目前無執行任務{!agent.everCalled && ' ・尚未呼叫'}
                          </span>
                        ) : (
                          truncate(
                            agent.currentCall.taskText ||
                              agent.currentCall.taskDescription ||
                              '（未取得任務內容）',
                            60,
                          )
                        )}
                      </td>
                      <td className={cellClass}>
                        {agent.status === 'idle' || !agent.currentCall
                          ? '—'
                          : durationLabel(agent.currentCall, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h3 className="text-accent-bright text-lg px-4 mb-2 mt-4">呼叫歷史</h3>
              {calls.length === 0 ? (
                <p className="text-text-muted text-sm px-4 py-6">尚未觀察到任何呼叫。</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b-2 border-border">
                      <th className={headClass}>呼叫時間</th>
                      <th className={headClass}>Agent</th>
                      <th className={headClass}>任務內容</th>
                      <th className={headClass}>狀態</th>
                      <th className={headClass}>執行時長</th>
                      <th className={headClass}>結束時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((call) => {
                      const expanded = expandedCallId === call.id;
                      const summary = call.taskDescription || call.taskText || '';
                      return (
                        <tr
                          key={call.id}
                          className={`${rowClass} cursor-pointer hover:bg-btn-bg`}
                          onClick={() => setExpandedCallId(expanded ? null : call.id)}
                        >
                          <td className={cellClass}>{formatTimestamp(call.startedAt)}</td>
                          <td className={cellClass}>{agentLabel(call)}</td>
                          <td className={cellClass}>
                            {expanded ? (
                              <div className="whitespace-pre-wrap break-words max-w-160">
                                {call.taskText || call.taskDescription || (
                                  <span className="text-text-muted">（未取得任務內容）</span>
                                )}
                              </div>
                            ) : summary ? (
                              <span className="text-text-muted">{truncate(summary, 60)}</span>
                            ) : (
                              <span className="text-text-muted">（未取得任務內容）</span>
                            )}
                          </td>
                          <td className={cellClass}>{CALL_STATUS_LABELS[call.status]}</td>
                          <td className={cellClass}>{durationLabel(call, now)}</td>
                          <td className={cellClass}>{formatTimestamp(call.endedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}

        <div className="px-4">
          <Button size="sm" onClick={onClose}>
            關閉
          </Button>
        </div>
      </div>
    </Modal>
  );
}

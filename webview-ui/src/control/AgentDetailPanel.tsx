/**
 * A single agent's detail — opened both by clicking its character in the
 * office and by clicking its row in `AgentPanel.tsx`. Both entry points
 * render this exact component fed by `useAgentDirectory()`'s
 * `computeAgentSummaries`, so the two can never show different status or
 * task text for the same agent (see agentDirectory.ts).
 */

import { useEffect, useState } from 'react';

import { Modal } from '../components/ui/Modal.js';
import { AGENT_STATUS_LABELS } from './agentDirectory.js';
import { CALL_STATUS_LABELS, durationLabel, formatTimestamp } from './callLogFormat.js';
import { useAgentDirectory } from './useAgentDirectory.js';

interface AgentDetailPanelProps {
  /** The roster file path identifying the agent, or null to stay closed.
   *  Rendering is gated on this rather than a separate isOpen flag, so a
   *  stale detail from a previous agent never flashes while this one closes. */
  agentKey: string | null;
  onClose: () => void;
}

const rowLabel = 'text-text-muted text-sm';

export function AgentDetailPanel({ agentKey, onClose }: AgentDetailPanelProps) {
  const { agents, connectionState } = useAgentDirectory();
  const [now, setNow] = useState(() => Date.now());
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);

  const agent = agentKey ? agents.find((a) => a.key === agentKey) : undefined;
  const isTicking = agent?.status === 'working' || agent?.status === 'waiting_response';

  useEffect(() => {
    if (!agentKey || !isTicking) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [agentKey, isTicking]);

  if (!agentKey) return null;

  return (
    <Modal
      isOpen={!!agentKey}
      onClose={onClose}
      title={agent?.name ?? 'Agent'}
      zIndex={60}
      className="w-192 max-w-[92vw]"
    >
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto px-4">
        {connectionState !== 'connected' && (
          <p className="text-warning text-sm">連線中斷，以下為最後已知狀態。</p>
        )}
        {!agent ? (
          <p className="text-text-muted text-sm py-4">
            找不到這個 Agent，可能已從 CC 的 Agent 名單移除。
          </p>
        ) : (
          <>
            {agent.description && <p className={rowLabel}>{agent.description}</p>}
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <span className={rowLabel}>狀態</span>
              <span>{AGENT_STATUS_LABELS[agent.status]}</span>

              <span className={rowLabel}>目前任務</span>
              <span>
                {agent.status === 'idle' || !agent.currentCall
                  ? '目前無執行任務'
                  : agent.currentCall.taskText ||
                    agent.currentCall.taskDescription || (
                      <span className={rowLabel}>（未取得任務內容）</span>
                    )}
                {!agent.everCalled && <span className={rowLabel}> ・尚未呼叫</span>}
              </span>

              {agent.currentCall && (
                <>
                  <span className={rowLabel}>本次呼叫時間</span>
                  <span>{formatTimestamp(agent.currentCall.startedAt)}</span>

                  <span className={rowLabel}>執行時長</span>
                  <span>{durationLabel(agent.currentCall, now)}</span>

                  {agent.currentCall.usage && (
                    <>
                      <span className={rowLabel}>Token</span>
                      <span>
                        輸入 {agent.currentCall.usage.inputTokens} ・輸出{' '}
                        {agent.currentCall.usage.outputTokens}
                        {agent.currentCall.usage.cacheReadTokens > 0 &&
                          ` ・快取讀取 ${agent.currentCall.usage.cacheReadTokens}`}
                        {agent.currentCall.usage.cacheCreationTokens > 0 &&
                          ` ・快取建立 ${agent.currentCall.usage.cacheCreationTokens}`}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>

            <h4 className="text-accent-bright text-base mt-4">呼叫歷史</h4>
            {agent.history.length === 0 ? (
              <p className={`${rowLabel} py-2`}>尚未呼叫。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {agent.history.map((call) => {
                  const expanded = expandedCallId === call.id;
                  return (
                    <li
                      key={call.id}
                      className="border border-border p-3 cursor-pointer hover:bg-btn-bg"
                      onClick={() => setExpandedCallId(expanded ? null : call.id)}
                    >
                      <div className="flex justify-between gap-4 text-sm">
                        <span>{formatTimestamp(call.startedAt)}</span>
                        <span>{CALL_STATUS_LABELS[call.status]}</span>
                        <span>{durationLabel(call, now)}</span>
                      </div>
                      {expanded && (
                        <div className="mt-2 text-sm whitespace-pre-wrap break-words">
                          {call.taskText || call.taskDescription || (
                            <span className={rowLabel}>（未取得任務內容）</span>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * The read-only CC activity dashboard.
 *
 * Replaces the old Office admin/dispatch surface: there is no create/edit
 * form and no Run/Accept/Request-changes control here. Office observes what
 * Claude Code actually did — a native agent's roster entry, and the calls
 * made to it — and shows it. See docs/task-log.md for the observation model
 * and its known limits (only within-conversation `Task` tool delegation is
 * captured in this version; a separately-launched `claude --agent X` session
 * cannot be tied back to an agent name today).
 */

import { useEffect, useState } from 'react';

import type { AgentCallLogEntry, AgentCallStatus } from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { useTaskLog } from './useTaskLog.js';

interface TaskLogPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const STATUS_LABELS: Record<AgentCallStatus, string> = {
  running: '執行中',
  waiting_response: '等待回應',
  ended: '已結束',
  failed: '失敗',
  unknown: '狀態未知',
};

const rowClass = 'border-b border-border last:border-0';
const cellClass = 'py-3 px-4 align-top text-sm';
const headClass = 'py-2 px-4 text-left text-text-muted text-xs uppercase tracking-wide';

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}時${String(minutes).padStart(2, '0')}分`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
  return `${seconds}秒`;
}

/** Live for a running call (ticks against `now`); fixed once a call ends.
 *  Never claims a duration when the start time itself is unknown. */
function durationLabel(call: AgentCallLogEntry, now: number): string {
  if (call.startUnknown || !call.startedAt) {
    return call.status === 'unknown' ? '未知' : '開始時間未知';
  }
  const start = new Date(call.startedAt).getTime();
  if (call.status === 'unknown') return '未知（連線中斷）';
  const end = call.endedAt ? new Date(call.endedAt).getTime() : now;
  return formatDuration(end - start);
}

function agentLabel(call: AgentCallLogEntry): string {
  return call.recognized ? call.agentName : `未辨識 Agent（${call.agentName}）`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function TaskLogPanel({ isOpen, onClose }: TaskLogPanelProps) {
  const { calls } = useTaskLog();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Live-updating duration for any running call — a render tick only, never
  // a per-second database write (see spec: 執行時長規則).
  useEffect(() => {
    if (!isOpen) return;
    const hasOpenCall = calls.some((call) => call.status === 'running');
    if (!hasOpenCall) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOpen, calls]);

  if (!isOpen) {
    return null;
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="任務紀錄" className="w-256 max-w-[92vw]">
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
        <p className="text-text-muted text-sm px-4">
          在 Claude Code 建立與指派的 Agent 呼叫紀錄，唯讀。Agent 的建立、修改與派工請在 Claude Code
          進行。
        </p>
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
                const expanded = expandedId === call.id;
                const summary = call.taskDescription || call.taskText || '';
                return (
                  <tr
                    key={call.id}
                    className={`${rowClass} cursor-pointer hover:bg-btn-bg`}
                    onClick={() => setExpandedId(expanded ? null : call.id)}
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
                    <td className={cellClass}>{STATUS_LABELS[call.status]}</td>
                    <td className={cellClass}>{durationLabel(call, now)}</td>
                    <td className={cellClass}>{formatTimestamp(call.endedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

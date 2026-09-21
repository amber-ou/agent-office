/**
 * Display formatting shared by `AgentPanel.tsx` and `AgentDetailPanel.tsx` —
 * kept in one place so a call's status, duration and identity read the same
 * way in both the full list and a single agent's detail.
 */

import type { AgentCallLogEntry, AgentCallStatus } from '../../../core/src/messages.js';

export const CALL_STATUS_LABELS: Record<AgentCallStatus, string> = {
  running: '執行中',
  waiting_response: '等待回應',
  ended: '已結束',
  failed: '失敗',
  unknown: '狀態未知',
  background_not_tracked: '背景委派（本版未追蹤結果）',
};

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}時${String(minutes).padStart(2, '0')}分`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
  return `${seconds}秒`;
}

/** Live for a running call (ticks against `now`); fixed once a call ends.
 *  Never claims a duration when the start time itself is unknown, and never
 *  computes one against "now" for a call whose real end isn't observed. */
export function durationLabel(call: AgentCallLogEntry, now: number): string {
  if (call.status === 'background_not_tracked') return '未追蹤（背景委派）';
  if (call.startUnknown || !call.startedAt) {
    return call.status === 'unknown' ? '未知' : '開始時間未知';
  }
  const start = new Date(call.startedAt).getTime();
  if (call.status === 'unknown') return '未知（連線中斷）';
  const end = call.endedAt ? new Date(call.endedAt).getTime() : now;
  return formatDuration(end - start);
}

export function agentLabel(call: AgentCallLogEntry): string {
  return call.recognized ? call.agentName : `未辨識 Agent（${call.agentName}）`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

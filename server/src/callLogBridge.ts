/**
 * Bridges `transcriptParser.ts`'s Task-tool call events into the persisted
 * call log and out to connected clients. Kept separate from
 * `transcriptParser.ts` itself (which knows nothing about storage or the
 * wire protocol) and from `nativeAgentRoster.ts` (which knows nothing about
 * calls) — this module is the one place that knows about both.
 */

import type { AgentCall } from '../../storage/src/index.js';
import type { AgentStateStore } from './agentStateStore.js';
import { getOfficeStorage } from './control/officeStorage.js';
import { resolveNativeAgentByName, scanNativeAgentRoster } from './nativeAgentRoster.js';
import type {
  TaskCallBackgroundInfo,
  TaskCallEndInfo,
  TaskCallStartInfo,
} from './transcriptParser.js';
import {
  setTaskCallBackgroundCallback,
  setTaskCallEndedCallback,
  setTaskCallStartedCallback,
} from './transcriptParser.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/** `AgentCall`'s shape matches `AgentCallLogEntry` (core/asyncapi.yaml) field
 *  for field; the cast is the one place that fact is asserted. */
function toWireCall(call: AgentCall): Record<string, unknown> {
  return call as unknown as Record<string, unknown>;
}

/** Wire the transcript parser's call events into storage + broadcast.
 *  Idempotent — safe to call again (last writer wins), matching every other
 *  module-level `set*Callback` this runtime installs. */
export function installCallLogBridge(store: AgentStateStore): void {
  setTaskCallStartedCallback((info: TaskCallStartInfo) => {
    const storage = getOfficeStorage();
    if (!storage) {
      if (debug) {
        console.log('[Agent Office] Call log: storage unavailable, call start not recorded');
      }
      return;
    }
    const resolved = resolveNativeAgentByName(info.subagentType, scanNativeAgentRoster());
    void storage.callLog
      .start({
        agentName: info.subagentType,
        recognized: resolved.recognized,
        ...(resolved.agentFilePath ? { agentFilePath: resolved.agentFilePath } : {}),
        parentSessionId: info.parentSessionId,
        toolUseId: info.toolUseId,
        ...(info.prompt ? { taskText: info.prompt } : {}),
        ...(info.description ? { taskDescription: info.description } : {}),
        // Observation is effectively instantaneous here (the JSONL tail is
        // read as it's written), so the server's own clock is used as the
        // real start time rather than trusting an unverified transcript field.
        startedAt: new Date().toISOString(),
      })
      .then((call) => store.broadcast({ type: 'agentCallUpdated', call: toWireCall(call) }))
      .catch((err) => {
        console.error('[Agent Office] Call log: failed to record call start:', err);
      });
  });

  setTaskCallEndedCallback((info: TaskCallEndInfo) => {
    const storage = getOfficeStorage();
    if (!storage) return;
    void storage.callLog
      .end({
        parentSessionId: info.parentSessionId,
        toolUseId: info.toolUseId,
        status: info.isError ? 'failed' : 'ended',
        endedAt: new Date().toISOString(),
      })
      .then(() => storage.callLog.get(info.parentSessionId, info.toolUseId))
      .then((call) => {
        if (call) store.broadcast({ type: 'agentCallUpdated', call: toWireCall(call) });
      })
      .catch((err) => {
        console.error('[Agent Office] Call log: failed to record call end:', err);
      });
  });

  setTaskCallBackgroundCallback((info: TaskCallBackgroundInfo) => {
    const storage = getOfficeStorage();
    if (!storage) return;
    // No `end()` here: this call's real completion isn't observed, so no
    // `endedAt` is ever recorded for it — only the status changes, to say so.
    void storage.callLog
      .markStatus(info.parentSessionId, info.toolUseId, 'background_not_tracked')
      .then(() => storage.callLog.get(info.parentSessionId, info.toolUseId))
      .then((call) => {
        if (call) store.broadcast({ type: 'agentCallUpdated', call: toWireCall(call) });
      })
      .catch((err) => {
        console.error('[Agent Office] Call log: failed to mark call background-untracked:', err);
      });
  });
}

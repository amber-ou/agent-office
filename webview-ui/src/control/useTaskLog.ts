/**
 * Read-only CC activity dashboard state in the webview.
 *
 * Subscribes to `nativeAgentRoster` (which native agents exist — CC's own
 * `~/.claude/agents`, not an Office Project/AgentDefinition) and the observed
 * call log (`agentCallLogSnapshot` / `agentCallUpdated`). There is
 * deliberately no command surface beyond `requestCallLog`: Office never
 * creates, edits, or dispatches anything here, it only displays what it
 * observed.
 */

import { useEffect, useState } from 'react';

import type { AgentCallLogEntry, NativeAgentRosterEntry } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface TaskLogView {
  roster: NativeAgentRosterEntry[];
  /** Newest first. */
  calls: AgentCallLogEntry[];
}

const EMPTY: TaskLogView = { roster: [], calls: [] };

export function useTaskLog(): TaskLogView {
  const [view, setView] = useState<TaskLogView>(EMPTY);

  useEffect(() => {
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'nativeAgentRoster') {
        setView((current) => ({ ...current, roster: message.agents }));
      } else if (message.type === 'agentCallLogSnapshot') {
        setView((current) => ({ ...current, calls: message.calls }));
      } else if (message.type === 'agentCallUpdated') {
        setView((current) => {
          const index = current.calls.findIndex((call) => call.id === message.call.id);
          const calls =
            index === -1
              ? // A call this window has never seen is new — newest first.
                [message.call, ...current.calls]
              : current.calls.map((call, i) => (i === index ? message.call : call));
          return { ...current, calls };
        });
      }
    });
    // The server also pushes both on the ready handshake; this covers a
    // panel opened after that, and a reconnect.
    transport.send({ type: 'requestCallLog' });
    return unsubscribe;
  }, []);

  return view;
}

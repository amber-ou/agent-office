/**
 * Read-only CC activity dashboard state in the webview.
 *
 * Subscribes to `nativeAgentRoster` (which native agents exist — CC's own
 * `~/.claude/agents`, not an Office Project/AgentDefinition), the observed
 * call log (`agentCallLogSnapshot` / `agentCallUpdated`), and the transport's
 * own connection state. There is deliberately no command surface beyond
 * `requestCallLog`: Office never creates, edits, or dispatches anything
 * here, it only displays what it observed.
 *
 * `agents` (per-agent status) is derived here via `computeAgentSummaries` —
 * the same function `AgentPanel.tsx` and `AgentDetailPanel.tsx` would
 * otherwise each have to call themselves. Deriving it once, in the one place
 * both read from, is what keeps a character, the full list and a single
 * agent's detail from ever disagreeing.
 */

import { useEffect, useMemo, useState } from 'react';

import type { AgentCallLogEntry, NativeAgentRosterEntry } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import type { TransportState } from '../transport/types.js';
import type { AgentSummary } from './agentDirectory.js';
import { computeAgentSummaries } from './agentDirectory.js';

interface RawState {
  roster: NativeAgentRosterEntry[];
  calls: AgentCallLogEntry[];
  /** True once at least one `nativeAgentRoster` message has arrived —
   *  distinguishes "still loading" from "confirmed zero agents". */
  rosterLoaded: boolean;
  /** The directory actually scanned, from the most recent roster message. */
  scanRoot: string | undefined;
}

export interface AgentDirectoryView extends RawState {
  agents: AgentSummary[];
  connectionState: TransportState;
}

const EMPTY_RAW: RawState = {
  roster: [],
  calls: [],
  rosterLoaded: false,
  scanRoot: undefined,
};

export function useAgentDirectory(): AgentDirectoryView {
  const [raw, setRaw] = useState<RawState>(EMPTY_RAW);
  const [connectionState, setConnectionState] = useState<TransportState>(transport.state);

  useEffect(() => {
    // Re-read on mount in case the state changed before this subscribed.
    setConnectionState(transport.state);
    return transport.onStateChange(setConnectionState);
  }, []);

  useEffect(() => {
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'nativeAgentRoster') {
        setRaw((current) => ({
          ...current,
          roster: message.agents,
          rosterLoaded: true,
          scanRoot: message.root,
        }));
      } else if (message.type === 'agentCallLogSnapshot') {
        setRaw((current) => ({ ...current, calls: message.calls }));
      } else if (message.type === 'agentCallUpdated') {
        setRaw((current) => {
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

  const agents = useMemo(
    () => computeAgentSummaries(raw.roster, raw.calls),
    [raw.roster, raw.calls],
  );

  return { ...raw, agents, connectionState };
}

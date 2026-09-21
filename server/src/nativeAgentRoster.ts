/**
 * The CC-native agent roster: what Office shows as persistent, idle-capable
 * characters, read straight from `~/.claude/agents/**\/*.md`. Independent of
 * any Office `AgentDefinition`/`Project` — no link-native-agent step, no
 * project membership required (see docs/task-log.md).
 */

import * as fs from 'node:fs';

import type { NativeAgentRosterEntry } from '../../storage/src/index.js';
import { discoverNativeAgents } from '../../storage/src/index.js';
import type { AgentStateStore } from './agentStateStore.js';
import { getClaudeDiscoveryPaths } from './control/officeStorage.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

export function scanNativeAgentRoster(): NativeAgentRosterEntry[] {
  return discoverNativeAgents(getClaudeDiscoveryPaths().claudeAgentsRoot);
}

/**
 * Resolve a Task tool's `subagent_type` to a roster file. Recognized only
 * when exactly one roster entry (not itself ambiguous) declares that name —
 * the same "never guess by name" rule `officeCharacters.ts` uses for session
 * identity. A built-in name (e.g. `general-purpose`) or one no current file
 * declares resolves to `recognized: false`.
 */
export function resolveNativeAgentByName(
  subagentType: string,
  roster: readonly NativeAgentRosterEntry[],
): { agentFilePath?: string; recognized: boolean } {
  const matches = roster.filter((a) => a.name === subagentType && !a.ambiguous);
  if (matches.length === 1) {
    return { agentFilePath: matches[0]!.filePath, recognized: true };
  }
  return { recognized: false };
}

export function broadcastNativeAgentRoster(store: AgentStateStore): NativeAgentRosterEntry[] {
  const agents = scanNativeAgentRoster();
  store.broadcast({ type: 'nativeAgentRoster', agents });
  return agents;
}

let watcher: fs.FSWatcher | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Watch `~/.claude/agents` and re-broadcast the roster on change, so a new
 * agent file appears without a manual reload. Best effort: recursive
 * `fs.watch` is unsupported on some platforms, in which case this falls back
 * to a coarse poll rather than throwing — a person's ability to see the
 * roster must not depend on this succeeding.
 */
export function watchNativeAgentRoster(store: AgentStateStore): () => void {
  stopWatchingNativeAgentRoster();
  const root = getClaudeDiscoveryPaths().claudeAgentsRoot;
  const rescan = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => broadcastNativeAgentRoster(store), 300);
  };
  try {
    fs.mkdirSync(root, { recursive: true });
    watcher = fs.watch(root, { recursive: true }, () => rescan());
    watcher.on('error', (err) => {
      if (debug) {
        console.log(
          `[Pixel Agents] Native agent roster: fs.watch error (${err.message}), falling back to polling`,
        );
      }
      startPolling(store);
    });
  } catch (err) {
    if (debug) {
      console.log(
        `[Pixel Agents] Native agent roster: fs.watch unavailable (${
          err instanceof Error ? err.message : String(err)
        }), falling back to polling`,
      );
    }
    startPolling(store);
  }
  return stopWatchingNativeAgentRoster;
}

function startPolling(store: AgentStateStore): void {
  if (pollTimer) return;
  let lastFingerprint = '';
  pollTimer = setInterval(() => {
    const agents = scanNativeAgentRoster();
    const fingerprint = JSON.stringify(agents);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      store.broadcast({ type: 'nativeAgentRoster', agents });
    }
  }, 3000);
}

export function stopWatchingNativeAgentRoster(): void {
  watcher?.close();
  watcher = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

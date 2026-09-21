/**
 * Whether a linked native agent's `--agent <name>` will actually resolve to
 * the file Office thinks it did, in the ONE scope Office can confirm:
 * user-level `~/.claude/agents/`, scanned recursively — the same root
 * `ccDiscoveryPaths.claudeAgentsRoot` already names for the Office→CC
 * direction of this bridge.
 *
 * Two failure modes, both refused rather than guessed past:
 *
 *  - The file lives OUTSIDE that tree. Claude Code also scans project-level
 *    `.claude/agents/` (walking up from the run's cwd), but Office has no
 *    single answer for "the run's cwd" independent of the sandbox it is
 *    about to build, so that scope is not checked — a file out here is
 *    refused rather than silently trusted.
 *  - Another `.md` file under the SAME tree declares the same `name:`. CC
 *    resolves `--agent <name>` by name alone (see `sub-agents.md`); two
 *    files with the same name is exactly the situation where it could pick
 *    the wrong one, and Office has no way to know which. Refused, never
 *    silently dispatched against either.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseNativeAgentFile } from './nativeAgentFile.js';

export interface NativeAgentDiscoverability {
  ok: boolean;
  reason?: string;
}

export function verifyNativeAgentDiscoverable(
  nativeAgentPath: string,
  ccName: string,
  claudeAgentsRoot: string,
): NativeAgentDiscoverability {
  const absolute = path.resolve(nativeAgentPath);
  const root = path.resolve(claudeAgentsRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return {
      ok: false,
      reason:
        `${absolute} is outside ${root}, which is where Claude Code looks for user-level ` +
        `subagents (it also scans a project's own .claude/agents/, but Office cannot confirm ` +
        `that scope independently of the run it is about to start, so a file outside the user-` +
        `level tree is refused rather than assumed reachable). Move the file under ` +
        `${root} and re-link it.`,
    };
  }

  const collisions = findOtherFilesWithName(root, ccName, absolute);
  if (collisions.length > 0) {
    return {
      ok: false,
      reason:
        `${collisions.length} other file(s) under ${root} also declare name "${ccName}": ` +
        `${collisions.join(', ')}. Claude Code resolves --agent by name alone, so which file ` +
        `it loads is ambiguous. Give this agent a unique name and re-link it.`,
    };
  }
  return { ok: true };
}

/**
 * One valid, parseable native agent file found under the roster scan.
 * `ambiguous` mirrors `verifyNativeAgentDiscoverable`'s name-collision check:
 * set when another file under the same root declares the same `name`, since
 * Office cannot then say which file `--agent <name>` would actually run.
 * A roster entry is shown either way — the ambiguity is surfaced to the
 * person, not hidden — but is never treated as a resolvable identity for a
 * dispatch match.
 */
export interface NativeAgentRosterEntry {
  name: string;
  description: string;
  filePath: string;
  ambiguous: boolean;
}

/**
 * Every valid `~/.claude/agents/**\/*.md` file, read fresh — this is the
 * whole CC agent roster Office can observe, independent of whether any of
 * them has ever been linked into an Office `AgentDefinition`. A file that
 * fails to parse (no front matter, no `name`, an unresolved conflict marker)
 * is silently left out: it is not a subagent definition Claude Code itself
 * could run either.
 */
export function discoverNativeAgents(claudeAgentsRoot: string): NativeAgentRosterEntry[] {
  const root = path.resolve(claudeAgentsRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  const found: { name: string; description: string; filePath: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const dir =
      (entry as fs.Dirent & { parentPath?: string; path?: string }).parentPath ??
      (entry as fs.Dirent & { path?: string }).path ??
      root;
    const filePath = path.join(dir, entry.name);
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseNativeAgentFile(text);
    if (!parsed.ok) {
      continue;
    }
    found.push({
      name: parsed.agent.fields.name,
      description: parsed.agent.fields.description,
      filePath,
    });
  }

  const byName = new Map<string, number>();
  for (const agent of found) {
    byName.set(agent.name, (byName.get(agent.name) ?? 0) + 1);
  }
  return found.map((agent) => ({ ...agent, ambiguous: (byName.get(agent.name) ?? 0) > 1 }));
}

/** Every `.md` file under `root` (recursively, `excluding`) whose front
 *  matter `name` field equals `name`. A file that fails to parse is simply
 *  not a match — it cannot be what `--agent <name>` resolves to either. */
function findOtherFilesWithName(root: string, name: string, excluding: string): string[] {
  const matches: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    // Node <22 does not set `entry.parentPath`; `.path` is the documented
    // fallback (deprecated but present) for the same value.
    const dir =
      (entry as fs.Dirent & { parentPath?: string; path?: string }).parentPath ??
      (entry as fs.Dirent & { path?: string }).path ??
      root;
    const file = path.join(dir, entry.name);
    if (path.resolve(file) === excluding) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseNativeAgentFile(text);
    if (parsed.ok && parsed.agent.fields.name === name) {
      matches.push(file);
    }
  }
  return matches;
}

/**
 * Reads Claude Code's OWN native subagent file format —
 * `~/.claude/agents/<name>.md`, written and maintained by Claude Code itself
 * (via `/agents`, a `Write` tool call, or hand-editing), never by Office.
 *
 * This is a different dialect from `frontMatter.ts`: that one is Office's own
 * format for `discovery/agent.md` (values are JSON). CC's real subagent front
 * matter is plain YAML-ish text — bare or quoted scalars, and `tools` as
 * either a comma-separated line or a YAML block list — so it needs its own,
 * separate, permissive parser. Nothing here writes; Office never edits a
 * native CC agent file, only reads it (see `linkNativeAgent.ts`).
 */

import { hasConflictMarkers } from './ccBridge.js';

const FENCE = '---';

export interface NativeAgentFields {
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];
  model?: string;
}

export interface ParsedNativeAgent {
  fields: NativeAgentFields;
  /** The instructions body — everything after the closing fence. */
  body: string;
}

export interface NativeAgentParseError {
  ok: false;
  reason: string;
}

export type NativeAgentParseResult = { ok: true; agent: ParsedNativeAgent } | NativeAgentParseError;

/**
 * Parse a native CC subagent file's text.
 *
 * Refuses (rather than guesses at) two situations: no front matter fence at
 * all — a file that is not a subagent definition, whatever else it might be —
 * and an unresolved git conflict marker, the same rule the Office-owned
 * bridge files use (see `ccBridge.ts`'s `hasConflictMarkers`).
 */
export function parseNativeAgentFile(text: string): NativeAgentParseResult {
  if (hasConflictMarkers(text)) {
    return { ok: false, reason: 'unresolved git merge conflict markers' };
  }
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${FENCE}\n`)) {
    return { ok: false, reason: 'no front matter: file does not start with a `---` fence' };
  }
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    return { ok: false, reason: 'front matter is never closed with a second `---` fence' };
  }
  const header = normalized.slice(FENCE.length + 1, end);
  const body = normalized.slice(end + 1 + FENCE.length).replace(/^\n+/, '');

  const raw = parseFlatYamlish(header);
  const name = firstString(raw['name']).trim();
  if (!name) {
    return { ok: false, reason: 'front matter has no `name` field — Claude Code requires one' };
  }

  return {
    ok: true,
    agent: {
      fields: {
        name,
        description: firstString(raw['description']).trim(),
        tools: toList(raw['tools']),
        disallowedTools: toList(raw['disallowedTools']),
        model: firstString(raw['model']).trim() || undefined,
      },
      body,
    },
  };
}

type RawValue = string | string[] | undefined;

function firstString(value: RawValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return '';
}

function toList(value: RawValue): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => v.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * A permissive, flat YAML-ish reader: `key: value` lines, an unquoted or
 * quoted scalar, or a block list (`key:` with no value, followed by `- item`
 * lines). Enough for CC's own subagent front matter, which is documented as
 * flat scalars plus one comma-separated or block-list field (`tools`) — not a
 * general YAML parser, and deliberately not one: anything this cannot make
 * sense of is left out rather than mis-parsed.
 */
function parseFlatYamlish(header: string): Record<string, RawValue> {
  const fields: Record<string, RawValue> = {};
  const lines = header.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const separator = line.indexOf(':');
    if (separator === -1 || /^\s/.test(line)) {
      i++;
      continue;
    }
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (!key) {
      i++;
      continue;
    }
    if (rest) {
      fields[key] = unquote(rest);
      i++;
      continue;
    }
    // No inline value: look ahead for a `- item` block list.
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length && /^\s*-\s+/.test(lines[j]!)) {
      items.push(unquote(lines[j]!.replace(/^\s*-\s+/, '').trim()));
      j++;
    }
    if (items.length > 0) {
      fields[key] = items;
      i = j;
    } else {
      i++;
    }
  }
  return fields;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

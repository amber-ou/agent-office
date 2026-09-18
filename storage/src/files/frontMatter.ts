/**
 * A tiny front-matter format for Agent-owned files.
 *
 * Values are JSON, always:
 *
 *   ---
 *   name: "Run a user interview"
 *   requiredTools: ["Read", "Grep"]
 *   ---
 *   the body
 *
 * JSON rather than bare text because a title may contain a colon, a quote or a
 * newline, and a format that is ambiguous about those is a format that loses
 * someone's content. It stays readable, and it needs no dependency.
 */

const FENCE = '---';

export type FrontMatterValue = string | string[];

export interface ParsedDocument {
  fields: Record<string, FrontMatterValue>;
  body: string;
}

export function serializeDocument(
  fields: Record<string, FrontMatterValue | undefined>,
  body: string,
): string {
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, FrontMatterValue] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n\n${body}`;
}

/**
 * Parse a document.
 *
 * A file with no front matter is not an error: it is a body with no fields,
 * which is exactly what a person who edited the file by hand may leave behind.
 */
export function parseDocument(text: string): ParsedDocument {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${FENCE}\n`)) {
    return { fields: {}, body: normalized };
  }
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    return { fields: {}, body: normalized };
  }
  const header = normalized.slice(FENCE.length + 1, end);
  const body = normalized.slice(end + FENCE.length + 1).replace(/^\n+/, '');

  const fields: Record<string, FrontMatterValue> = {};
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key || !raw) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === 'string') {
        fields[key] = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        fields[key] = value as string[];
      }
    } catch {
      // Hand-edited and not JSON. Keep the text rather than dropping the line.
      fields[key] = raw;
    }
  }
  return { fields, body };
}

export function textField(
  fields: Record<string, FrontMatterValue>,
  key: string,
  fallback = '',
): string {
  const value = fields[key];
  return typeof value === 'string' ? value : fallback;
}

export function listField(fields: Record<string, FrontMatterValue>, key: string): string[] {
  const value = fields[key];
  if (Array.isArray(value)) {
    return [...value];
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

/**
 * `discoverNativeAgents` — the CC agent roster scan the new call-log
 * feature uses to show idle characters without any link-native-agent step.
 * `verifyNativeAgentDiscoverable` already covers the collision/outside-root
 * refusal logic these share; this file covers the roster LISTING itself.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverNativeAgents } from '../src/index.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-roster-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeAgent(relativePath: string, name: string, description = ''): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\nname: ${name}\ndescription: ${description}\n---\nBody text.\n`);
}

describe('discoverNativeAgents', () => {
  it('returns an empty roster for a missing directory', () => {
    expect(discoverNativeAgents(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('returns an empty roster for an empty directory', () => {
    expect(discoverNativeAgents(root)).toEqual([]);
  });

  it('reads a valid agent file as one unambiguous roster entry', () => {
    writeAgent('skill-retriever.md', 'skill-retriever', 'Finds relevant skills.');
    const roster = discoverNativeAgents(root);
    expect(roster).toEqual([
      {
        name: 'skill-retriever',
        description: 'Finds relevant skills.',
        filePath: path.join(root, 'skill-retriever.md'),
        ambiguous: false,
      },
    ]);
  });

  it('scans nested directories too', () => {
    writeAgent(path.join('team', 'reviewer.md'), 'reviewer');
    const roster = discoverNativeAgents(root);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.name).toBe('reviewer');
  });

  it('excludes a file with no parseable front matter', () => {
    fs.writeFileSync(path.join(root, 'not-an-agent.md'), '# Just a heading\n');
    expect(discoverNativeAgents(root)).toEqual([]);
  });

  it('flags two files declaring the same name as ambiguous, both included', () => {
    writeAgent('a.md', 'duplicate-name');
    writeAgent('b.md', 'duplicate-name');
    const roster = discoverNativeAgents(root);
    expect(roster).toHaveLength(2);
    expect(roster.every((agent) => agent.ambiguous)).toBe(true);
    expect(roster.every((agent) => agent.name === 'duplicate-name')).toBe(true);
  });

  it('does not flag two different agents with different names', () => {
    writeAgent('a.md', 'agent-a');
    writeAgent('b.md', 'agent-b');
    const roster = discoverNativeAgents(root);
    expect(roster.every((agent) => !agent.ambiguous)).toBe(true);
  });
});

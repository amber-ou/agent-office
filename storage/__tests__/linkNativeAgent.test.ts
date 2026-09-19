/**
 * The reverse bridge direction: a Claude Code native subagent file as the
 * ONLY source for an Office Agent (`linkNativeAgent.ts`, `nativeAgentFile.ts`)
 * — no content copy into `discovery/agent.md`, no migration, invisible to the
 * ordinary Office→CC discovery bridge.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { systemClock, uuidIdGenerator } from '../../domain/src/index.js';
import type { SqliteStorage } from '../src/index.js';
import {
  linkNativeAgentFile,
  migrateAgentFiles,
  openSqliteStorage,
  parseNativeAgentFile,
  syncCcBridge,
} from '../src/index.js';

const DEPS = { ids: uuidIdGenerator, clock: systemClock };

let dataRoot: string;
let nativeRoot: string;
let storage: SqliteStorage;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-native-'));
  nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-native-'));
  storage = openSqliteStorage({ dataRoot });
});

afterEach(() => {
  storage.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(nativeRoot, { recursive: true, force: true });
});

function writeNativeFile(name: string, contents: string): string {
  const file = path.join(nativeRoot, `${name}.md`);
  fs.writeFileSync(file, contents);
  return file;
}

const REVIEWER = [
  '---',
  'name: code-reviewer',
  'description: Reviews code for correctness and clarity',
  'tools: Read, Grep, Bash',
  'model: sonnet',
  '---',
  '',
  'You are a careful, concise code reviewer.',
  '',
].join('\n');

describe('parseNativeAgentFile', () => {
  it('reads flat scalar fields and the comma-separated tools line', () => {
    const result = parseNativeAgentFile(REVIEWER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.fields).toEqual({
      name: 'code-reviewer',
      description: 'Reviews code for correctness and clarity',
      tools: ['Read', 'Grep', 'Bash'],
      disallowedTools: [],
      model: 'sonnet',
    });
    expect(result.agent.body).toBe('You are a careful, concise code reviewer.\n');
  });

  it('reads a YAML block-list form of tools', () => {
    const text = [
      '---',
      'name: writer',
      'description: Writes copy',
      'tools:',
      '  - Read',
      '  - Write',
      '---',
      '',
      'Body here.',
    ].join('\n');
    const result = parseNativeAgentFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.fields.tools).toEqual(['Read', 'Write']);
  });

  it('refuses a file with no front matter fence', () => {
    const result = parseNativeAgentFile('Just some text, not a subagent file.');
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('no front matter') });
  });

  it('refuses a file missing the closing fence', () => {
    const result = parseNativeAgentFile('---\nname: broken\n\nBody without a closing fence.');
    expect(result.ok).toBe(false);
  });

  it('refuses a file with no name field', () => {
    const text = ['---', 'description: no name here', '---', '', 'Body.'].join('\n');
    const result = parseNativeAgentFile(text);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('name') });
  });

  it('refuses a file with an unresolved conflict marker', () => {
    const text = [
      '---',
      'name: conflicted',
      '---',
      '',
      '<<<<<<< HEAD',
      'one version',
      '=======',
      'another version',
      '>>>>>>> branch',
    ].join('\n');
    const result = parseNativeAgentFile(text);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('conflict'),
    });
  });
});

describe('linkNativeAgentFile', () => {
  it('registers a new agent whose only source is the external file', async () => {
    const file = writeNativeFile('reviewer', REVIEWER);
    const result = await linkNativeAgentFile(storage.repos, storage.agentFiles, file, DEPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('linked');
    expect(result.agent.name).toBe('code-reviewer');
    expect(result.agent.systemPrompt).toBe('You are a careful, concise code reviewer.\n');
    expect(result.agent.model).toBe('sonnet');

    const meta = await storage.agentFiles.readOfficeMeta(result.agent.id);
    expect(meta?.nativeAgentPath).toBe(path.resolve(file));

    // No content copy: discovery/agent.md is never written for this agent.
    expect(await storage.agentFiles.readInstructions(result.agent.id)).toBeNull();
    expect(await storage.agentMigrations.isMigrated(result.agent.id)).toBe(false);
  });

  it('re-linking the same path refreshes the same agent instead of creating a second one', async () => {
    const file = writeNativeFile('reviewer', REVIEWER);
    const first = await linkNativeAgentFile(storage.repos, storage.agentFiles, file, DEPS);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    fs.writeFileSync(
      file,
      REVIEWER.replace('You are a careful, concise code reviewer.', 'You are now terser.'),
    );
    const second = await linkNativeAgentFile(storage.repos, storage.agentFiles, file, DEPS);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe('refreshed');
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.agent.systemPrompt).toContain('You are now terser.');

    expect((await storage.repos.agents.list()).length).toBe(1);
  });

  it('refuses a native file with an unresolved conflict marker, without touching the database', async () => {
    const file = writeNativeFile(
      'conflicted',
      ['---', 'name: conflicted', '---', '', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> b'].join(
        '\n',
      ),
    );
    const result = await linkNativeAgentFile(storage.repos, storage.agentFiles, file, DEPS);
    expect(result.ok).toBe(false);
    expect((await storage.repos.agents.list()).length).toBe(0);
  });

  it('reports a missing file rather than inventing an agent for it', async () => {
    const result = await linkNativeAgentFile(
      storage.repos,
      storage.agentFiles,
      path.join(nativeRoot, 'nope.md'),
      DEPS,
    );
    expect(result.ok).toBe(false);
    expect((await storage.repos.agents.list()).length).toBe(0);
  });

  it('is invisible to the ordinary agent-file migration and the Office→CC discovery bridge', async () => {
    const file = writeNativeFile('reviewer', REVIEWER);
    const linked = await linkNativeAgentFile(storage.repos, storage.agentFiles, file, DEPS);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;

    const migration = await migrateAgentFiles(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      systemClock.now(),
    );
    expect(migration.written).toBe(0);
    expect(migration.migrated).toEqual([]);
    // Still no discovery/agent.md: migration did not adopt it.
    expect(await storage.agentFiles.readInstructions(linked.agent.id)).toBeNull();

    const sync = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      {
        claudeAgentsRoot: path.join(dataRoot, 'fake-claude-agents'),
        claudeSkillsRoot: path.join(dataRoot, 'fake-claude-skills'),
      },
      systemClock.now(),
    );
    expect(sync.synced).toEqual([]);
    expect(sync.damaged).toEqual([]);
    expect(sync.linksCreated).toBe(0);
  });
});

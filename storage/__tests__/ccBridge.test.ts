/**
 * The Claude Code discovery bridge: `discovery/agent.md` as the single
 * source for instructions + CC fields, `office.json` for Office-only fields,
 * the knowledge index, qualified skill names, directory-link creation, the
 * second-computer bootstrap import, and the legacy instructions.md backfill.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentId } from '../../domain/src/index.js';
import {
  createAgentDefinition,
  createSkill,
  systemClock,
  ToolMode,
  uuidIdGenerator,
} from '../../domain/src/index.js';
import type { SqliteStorage } from '../src/index.js';
import {
  backfillCcBridge,
  ccIdentifierFor,
  ensureDirectoryLink,
  hasConflictMarkers,
  importAgentsFromDisk,
  migrateAgentFiles,
  openSqliteStorage,
  qualifiedSkillName,
  syncCcBridge,
} from '../src/index.js';

const DEPS = { ids: uuidIdGenerator, clock: systemClock };
const NOW = '2026-09-18T00:00:00.000Z';

let dataRoot: string;
let claudeRoot: string;
let storage: SqliteStorage;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-ccbridge-'));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  storage = openSqliteStorage({ dataRoot });
});

afterEach(() => {
  storage.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

function discoveryPaths() {
  return {
    claudeAgentsRoot: path.join(claudeRoot, 'agents'),
    claudeSkillsRoot: path.join(claudeRoot, 'skills'),
  };
}

async function agentWithSkill(name = 'UX Agent', role = 'ux'): Promise<AgentId> {
  const agent = createAgentDefinition(
    {
      name,
      role,
      provider: 'claude',
      description: 'Runs research.',
      systemPrompt: 'Cite the transcript.',
      tools: [
        { name: 'Read', mode: ToolMode.ALLOW },
        { name: 'Bash', mode: ToolMode.DENY },
      ],
    },
    DEPS,
  );
  await storage.repos.agents.put(agent);
  const skill = createSkill(
    {
      agentId: agent.id,
      slug: 'interview',
      name: 'Run an interview',
      kind: 'workflow',
      description: 'Semi-structured',
      source: { origin: 'content', ref: { store: 'inline', content: 'Ask open questions.' } },
    },
    DEPS,
  );
  await storage.repos.skills.put(skill);
  await migrateAgentFiles(storage.repos, storage.agentFiles, storage.agentMigrations, NOW);
  return agent.id;
}

describe('discovery/agent.md is the single source for instructions and CC fields', () => {
  it('round-trips instructions through the body without touching CC fields', async () => {
    const agentId = await agentWithSkill();
    await storage.agentFiles.writeCcFields(agentId, {
      name: 'ux-agent-test',
      description: 'Runs research.',
      tools: ['Read'],
      disallowedTools: ['Bash'],
    });

    await storage.agentFiles.writeInstructions(agentId, 'Cite sources and dates.');

    expect(await storage.agentFiles.readInstructions(agentId)).toBe('Cite sources and dates.');
    const cc = await storage.agentFiles.readCcFields(agentId);
    expect(cc).toEqual({
      name: 'ux-agent-test',
      description: 'Runs research.',
      tools: ['Read'],
      disallowedTools: ['Bash'],
      model: undefined,
    });
  });

  it('keeps the body when only CC fields are rewritten', async () => {
    const agentId = await agentWithSkill();
    await storage.agentFiles.writeInstructions(agentId, 'Original body.');
    await storage.agentFiles.writeCcFields(agentId, {
      name: 'ux-agent-test',
      description: 'v1',
      tools: [],
      disallowedTools: [],
    });
    await storage.agentFiles.writeCcFields(agentId, {
      name: 'ignored-if-different',
      description: 'v2',
      tools: ['Read'],
      disallowedTools: [],
    });

    expect(await storage.agentFiles.readInstructions(agentId)).toBe('Original body.');
    const cc = await storage.agentFiles.readCcFields(agentId);
    // The name is sticky: the second write could not change it.
    expect(cc?.name).toBe('ux-agent-test');
    expect(cc?.description).toBe('v2');
    expect(cc?.tools).toEqual(['Read']);
  });

  it('CC-style edits to the body are what Office reads back (bidirectional)', async () => {
    const agentId = await agentWithSkill();
    await storage.agentFiles.writeCcFields(agentId, {
      description: 'x',
      tools: [],
      disallowedTools: [],
    });

    // Simulate a human editing discovery/agent.md directly through Claude
    // Code — a plain fs write, not through the port.
    const file = path.join(storage.agentFiles.root, agentId, 'discovery', 'agent.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('x', 'x'), 'utf8'); // sanity: file exists
    fs.writeFileSync(
      file,
      original.replace(/\n\n$/, '') + '\nEdited by a human through Claude Code.\n',
      'utf8',
    );

    expect(await storage.agentFiles.readInstructions(agentId)).toContain(
      'Edited by a human through Claude Code.',
    );
  });

  it('survives an ATOMIC-RENAME edit made through the CC-side junction itself', async () => {
    // This is the scenario the whole symlink-over-hardlink decision rests
    // on: many editors (and Office's own writeAtomic) save by writing a temp
    // file and renaming it over the target, which repoints the PATH to a new
    // inode. A hardlink from `.claude/agents/` would go stale here; a
    // directory link survives because it resolves the path fresh every time.
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, NOW);

    const ccSidePath = path.join(paths.claudeAgentsRoot, agentId, 'agent.md');
    expect(fs.existsSync(ccSidePath)).toBe(true); // resolves through the junction
    const tmp = `${ccSidePath}.tmp`;
    fs.writeFileSync(tmp, '---\nname: "x"\ndescription: "edited via CC"\n---\n\nRewritten body.');
    fs.renameSync(tmp, ccSidePath); // atomic rename, through the junction

    expect(await storage.agentFiles.readInstructions(agentId)).toBe('Rewritten body.');
    const cc = await storage.agentFiles.readCcFields(agentId);
    expect(cc?.description).toBe('edited via CC');
  });
});

describe('the knowledge pointer', () => {
  it('is appended to instructions so the agent knows to look, and only once', async () => {
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, NOW);

    const first = (await storage.agentFiles.readInstructions(agentId))!;
    expect(first).toContain('Cite the transcript.'); // original instructions kept
    expect(first).toContain(`.agent-office/agents/${agentId}/knowledge/`);
    expect(first).toContain('index.md');
    // `$HOME` is the RESOLUTION HINT, not a baked-in path; no actual absolute
    // path for this machine appears anywhere in the text.
    expect(first).not.toMatch(/C:\\|\/home\/|\/Users\//);

    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, NOW);
    const second = (await storage.agentFiles.readInstructions(agentId))!;
    expect(second).toBe(first); // idempotent: not appended twice
  });
});

describe('a junction failure is reported per resource, not fatal to the whole run', () => {
  it('reports one agent link failure and still syncs the next agent', async () => {
    const oneId = await agentWithSkill('One', 'ux');
    const twoId = await agentWithSkill('Two', 'research');
    const paths = discoveryPaths();

    // Make the whole agents root unusable as a directory: a FILE sits where
    // it needs to go, so mkdirSync(recursive) over it throws rather than
    // silently succeeding — a stand-in for a real permission refusal.
    fs.mkdirSync(path.dirname(paths.claudeAgentsRoot), { recursive: true });
    fs.writeFileSync(paths.claudeAgentsRoot, 'blocking file', 'utf8');

    const report = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      paths,
      NOW,
    );

    // Both agents' link paths sit under the same blocked root, so both link
    // attempts fail — the point is that the FIRST failure does not abort the
    // loop: content sync still completes, and both failures are reported
    // individually rather than one thrown exception swallowing the rest.
    expect(report.linkFailures.map((f) => f.agentId).sort()).toEqual([oneId, twoId].sort());
    expect(report.synced.sort()).toEqual([oneId, twoId].sort());
    // Content that has nothing to do with the blocked link still landed.
    expect(await storage.agentFiles.readOfficeMeta(oneId)).not.toBeNull();
    expect(await storage.agentFiles.readOfficeMeta(twoId)).not.toBeNull();
  });
});

describe('office.json holds only Office-exclusive fields', () => {
  it('never duplicates name, description, tools or model', async () => {
    const agentId = await agentWithSkill();
    const agent = (await storage.repos.agents.get(agentId))!;

    const now = systemClock.now();
    const paths = discoveryPaths();
    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, now);

    const meta = await storage.agentFiles.readOfficeMeta(agentId);
    expect(meta).not.toBeNull();
    expect(meta).not.toHaveProperty('name');
    expect(meta).not.toHaveProperty('description');
    expect(meta).not.toHaveProperty('tools');
    expect(meta).not.toHaveProperty('model');
    expect(meta?.displayName).toBe(agent.name);
    expect(meta?.role).toBe('ux');
  });
});

describe('knowledge index', () => {
  it('lists knowledge items without claiming anything auto-loads them', async () => {
    const agentId = await agentWithSkill();
    const location = await storage.repos.blobs.write(
      { owner: { kind: 'agent', agentId }, name: 'guide.md' },
      'BODY',
    );
    const { createAgentKnowledge } = await import('../../domain/src/index.js');
    const knowledge = createAgentKnowledge(
      {
        agentId,
        type: 'ux_research',
        title: 'Interview guide',
        source: { origin: 'human' },
        location,
      },
      DEPS,
    );
    await storage.repos.agentKnowledge.put(knowledge);
    // The agent already migrated in agentWithSkill(); a second migrate() is a
    // no-op for it (migrateAgentFiles only writes an agent's FIRST time
    // through), so write the file directly, the way the control-plane's own
    // createAgentKnowledge flow does for an already file-backed agent.
    await storage.agentFiles.writeKnowledge(
      agentId,
      knowledge.id,
      { title: knowledge.title, type: knowledge.type, content: 'BODY', tags: knowledge.tags },
      { createdAt: knowledge.createdAt, updatedAt: knowledge.updatedAt },
    );

    await storage.agentFiles.rebuildKnowledgeIndex(agentId);
    const index = fs.readFileSync(
      path.join(storage.agentFiles.root, agentId, 'knowledge', 'index.md'),
      'utf8',
    );
    expect(index).toContain('Interview guide');
    expect(index).toContain('does not get loaded automatically');
    // The index itself is never picked up as a knowledge item.
    expect(await storage.agentFiles.listKnowledge(agentId)).toHaveLength(1);
  });
});

describe('conflict markers', () => {
  it('are detected', () => {
    expect(hasConflictMarkers('normal text')).toBe(false);
    expect(hasConflictMarkers('<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch')).toBe(true);
  });

  it('stop a conflicted agent from being linked or run', async () => {
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    const file = path.join(storage.agentFiles.root, agentId, 'discovery', 'agent.md');
    fs.writeFileSync(file, '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\n', 'utf8');

    const report = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      paths,
      NOW,
    );
    expect(report.synced).toEqual([]);
    expect(report.damaged).toHaveLength(1);
    expect(report.damaged[0]?.resource).toBe('agent');
    expect(fs.existsSync(path.join(paths.claudeAgentsRoot, agentId))).toBe(false);
  });
});

describe('discovery links', () => {
  it('links only discovery/, never skills or knowledge, into .claude/agents/', async () => {
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    const report = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      paths,
      NOW,
    );
    expect(report.synced).toEqual([agentId]);

    const linkPath = path.join(paths.claudeAgentsRoot, agentId);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const seenThroughLink = fs.readdirSync(linkPath);
    expect(seenThroughLink).toEqual(['agent.md']);
  });

  it('qualifies skill names so two agents cannot collide, and links each skill', async () => {
    const oneId = await agentWithSkill('One', 'ux');
    const twoId = await agentWithSkill('Two', 'ux'); // same role → same identifier prefix risk
    const paths = discoveryPaths();
    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, NOW);

    const oneSkills = await storage.agentFiles.listSkills(oneId);
    const twoSkills = await storage.agentFiles.listSkills(twoId);
    expect(oneSkills[0]?.skill.name).not.toBe(twoSkills[0]?.skill.name);
    expect(fs.readdirSync(paths.claudeSkillsRoot).sort()).toEqual(
      [oneSkills[0]!.skill.name, twoSkills[0]!.skill.name].sort(),
    );
  });

  it('never touches a real, non-link directory already at the target path', async () => {
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    fs.mkdirSync(path.join(paths.claudeAgentsRoot, agentId), { recursive: true });
    fs.writeFileSync(
      path.join(paths.claudeAgentsRoot, agentId, 'someone-elses.md'),
      'not ours',
      'utf8',
    );

    const report = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      paths,
      NOW,
    );
    expect(report.skippedForeignLinks).toContain(path.join(paths.claudeAgentsRoot, agentId));
    expect(
      fs.readFileSync(path.join(paths.claudeAgentsRoot, agentId, 'someone-elses.md'), 'utf8'),
    ).toBe('not ours');
  });

  it('is idempotent: a second sync creates no new links', async () => {
    await agentWithSkill();
    const paths = discoveryPaths();
    const first = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      paths,
      NOW,
    );
    const second = await syncCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      paths,
      NOW,
    );
    expect(first.linksCreated).toBeGreaterThan(0);
    expect(second.linksCreated).toBe(0);
  });
});

describe('ccIdentifierFor / qualifiedSkillName', () => {
  it('is deterministic in shape and collision-free by construction', () => {
    const id = ccIdentifierFor('UX Research', '12345678-90ab-cdef-1234-567890abcdef');
    expect(id).toBe('ux-research-12345678');
    expect(qualifiedSkillName(id, 'interview')).toBe('ux-research-12345678--interview');
  });
});

describe('second-computer bootstrap: importAgentsFromDisk', () => {
  it('registers an agent whose files exist but has no database row', async () => {
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, NOW);

    // Simulate "second computer": a fresh, empty database, same files on disk.
    const freshDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-fresh-'));
    fs.cpSync(path.join(dataRoot, 'agents'), path.join(freshDataRoot, 'agents'), {
      recursive: true,
    });
    const fresh = openSqliteStorage({ dataRoot: freshDataRoot });
    try {
      expect(await fresh.repos.agents.get(agentId)).toBeNull();

      const report = await importAgentsFromDisk(
        fresh.repos,
        fresh.agentFiles,
        fresh.agentMigrations,
        NOW,
      );
      expect(report.imported).toEqual([agentId]);
      expect(report.damaged).toEqual([]);

      const registered = await fresh.repos.agents.get(agentId);
      expect(registered?.name).toBe('UX Agent');
      expect(registered?.role).toBe('ux');
      expect(await fresh.agentMigrations.isMigrated(agentId)).toBe(true);
    } finally {
      fresh.close();
      fs.rmSync(freshDataRoot, { recursive: true, force: true });
    }
  });

  it('reports, and never registers, an agent whose agent.md has a conflict marker', async () => {
    const agentId = await agentWithSkill();
    const paths = discoveryPaths();
    await syncCcBridge(storage.repos, storage.agentFiles, storage.agentMigrations, paths, NOW);
    fs.writeFileSync(
      path.join(dataRoot, 'agents', agentId, 'discovery', 'agent.md'),
      '<<<<<<< HEAD\n=======\n>>>>>>> x\n',
      'utf8',
    );

    const freshDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-fresh2-'));
    fs.cpSync(path.join(dataRoot, 'agents'), path.join(freshDataRoot, 'agents'), {
      recursive: true,
    });
    const fresh = openSqliteStorage({ dataRoot: freshDataRoot });
    try {
      const report = await importAgentsFromDisk(
        fresh.repos,
        fresh.agentFiles,
        fresh.agentMigrations,
        NOW,
      );
      expect(report.imported).toEqual([]);
      expect(report.damaged).toHaveLength(1);
      expect(await fresh.repos.agents.get(agentId)).toBeNull();
    } finally {
      fresh.close();
      fs.rmSync(freshDataRoot, { recursive: true, force: true });
    }
  });
});

describe('backfillCcBridge: legacy instructions.md → discovery/agent.md', () => {
  it('moves content, backs up the legacy file, and never deletes it', async () => {
    const agentId = await agentWithSkill();
    // Undo what the current writeInstructions already did, to simulate an
    // agent migrated before the bridge existed: only the flat legacy file.
    const legacyPath = path.join(dataRoot, 'agents', agentId, 'instructions.md');
    fs.writeFileSync(legacyPath, 'Cite the transcript.', 'utf8');
    fs.rmSync(path.join(dataRoot, 'agents', agentId, 'discovery', 'agent.md'), { force: true });
    expect(await storage.agentFiles.readInstructions(agentId)).toBeNull();

    const report = await backfillCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      NOW,
    );
    expect(report.backfilled).toEqual([agentId]);
    expect(await storage.agentFiles.readInstructions(agentId)).toBe('Cite the transcript.');
    expect(fs.existsSync(`${legacyPath}.bak`)).toBe(true);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('Cite the transcript.'); // original untouched

    // Idempotent.
    const second = await backfillCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      NOW,
    );
    expect(second.backfilled).toEqual([]);
    expect(second.alreadyDone).toEqual([agentId]);
  });

  it('never overwrites a discovery/agent.md that already differs', async () => {
    const agentId = await agentWithSkill();
    const legacyPath = path.join(dataRoot, 'agents', agentId, 'instructions.md');
    fs.writeFileSync(legacyPath, 'Legacy text.', 'utf8');
    await storage.agentFiles.writeInstructions(agentId, 'A different, newer body.');

    const report = await backfillCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      NOW,
    );
    expect(report.conflicts).toHaveLength(1);
    expect(await storage.agentFiles.readInstructions(agentId)).toBe('A different, newer body.');
  });
});

describe('ownership safety mirrors the hook installer: never touch a link that is not ours', () => {
  it('ensureDirectoryLink refuses a real directory and a foreign link alike', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'target-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
    const linkPath = path.join(claudeRoot, 'agents', 'some-id');

    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.mkdirSync(linkPath); // a real directory, not ours
    expect(ensureDirectoryLink(linkPath, target).skippedForeign).toBe(true);
    fs.rmSync(linkPath, { recursive: true, force: true });

    fs.symlinkSync(other, linkPath, 'junction'); // a link, but to something else
    expect(ensureDirectoryLink(linkPath, target).skippedForeign).toBe(true);

    fs.rmSync(linkPath, { force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
});

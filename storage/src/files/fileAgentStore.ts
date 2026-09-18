/**
 * Filesystem implementation of `AgentFileStore`.
 *
 * Path safety is structural rather than defensive: every path segment is an
 * id that must pass `isCanonicalId`, so nothing a person types — an agent's
 * name, a skill's slug, a knowledge title — ever reaches the filesystem. A
 * segment that is not a canonical uuid is refused before any path is built,
 * which makes `..`, an absolute path, a symlinked name and a Windows drive
 * letter all the same rejected input. The resolved path is then checked to be
 * inside the owning agent's directory, so a future change that loosens the id
 * rule still cannot escape.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentId, AgentKnowledge, Skill, Timestamp } from '../../../domain/src/index.js';
import {
  asAgentId,
  asAgentKnowledgeId,
  asSkillId,
  isCanonicalId,
} from '../../../domain/src/index.js';
import type {
  AgentFileStore,
  KnowledgeFileInput,
  SkillFileInput,
  StoredKnowledge,
  StoredSkill,
} from '../agentFiles.js';
import { listField, parseDocument, serializeDocument, textField } from './frontMatter.js';

export const AGENTS_DIR_NAME = 'agents';
const AGENT_MARKER = 'agent.json';
const INSTRUCTIONS_FILE = 'instructions.md';
const SKILLS_DIR = 'skills';
const SKILL_FILE = 'SKILL.md';
const KNOWLEDGE_DIR = 'knowledge';

/** The marker file. Identity only — never a second copy of editable fields. */
interface AgentMarker {
  id: string;
  schema: 1;
  createdAt: Timestamp;
  /** Set once this agent's files are authoritative. */
  migratedAt?: Timestamp;
}

export class FileAgentStore implements AgentFileStore {
  constructor(readonly root: string) {}

  async ensureAgent(agentId: AgentId, now: Timestamp): Promise<void> {
    const dir = this.agentDir(agentId);
    fs.mkdirSync(path.join(dir, SKILLS_DIR), { recursive: true });
    fs.mkdirSync(path.join(dir, KNOWLEDGE_DIR), { recursive: true });
    if (!fs.existsSync(path.join(dir, AGENT_MARKER))) {
      this.writeMarker(agentId, { id: agentId, schema: 1, createdAt: now });
    }
  }

  async isMigrated(agentId: AgentId): Promise<boolean> {
    return this.readMarker(agentId)?.migratedAt !== undefined;
  }

  async markMigrated(agentId: AgentId, now: Timestamp): Promise<void> {
    const marker = this.readMarker(agentId) ?? { id: agentId, schema: 1 as const, createdAt: now };
    this.writeMarker(agentId, { ...marker, migratedAt: now });
  }

  async readInstructions(agentId: AgentId): Promise<string | null> {
    return readIfPresent(path.join(this.agentDir(agentId), INSTRUCTIONS_FILE));
  }

  async writeInstructions(agentId: AgentId, instructions: string): Promise<void> {
    writeAtomic(path.join(this.agentDir(agentId), INSTRUCTIONS_FILE), instructions);
  }

  // ── Skills ─────────────────────────────────────────────────────

  async listSkills(agentId: AgentId): Promise<StoredSkill[]> {
    const dir = path.join(this.agentDir(agentId), SKILLS_DIR);
    const stored: StoredSkill[] = [];
    for (const id of listIdDirectories(dir)) {
      const skill = await this.readSkill(agentId, id);
      if (skill) {
        stored.push(skill);
      }
    }
    return stored.sort((a, b) => a.skill.createdAt.localeCompare(b.skill.createdAt));
  }

  async readSkill(agentId: AgentId, skillId: string): Promise<StoredSkill | null> {
    const text = readIfPresent(this.skillPath(agentId, skillId));
    if (text === null) {
      return null;
    }
    const { fields, body } = parseDocument(text);
    const skill: Skill = {
      id: asSkillId(skillId),
      agentId,
      slug: textField(fields, 'slug', skillId),
      name: textField(fields, 'name', skillId),
      description: textField(fields, 'description'),
      kind: textField(fields, 'kind', 'instruction') as Skill['kind'],
      // The body IS the skill's content: one file, one source.
      source: { origin: 'content', ref: { store: 'inline', content: body } },
      requiredTools: listField(fields, 'requiredTools'),
      createdAt: textField(fields, 'createdAt'),
      updatedAt: textField(fields, 'updatedAt'),
    };
    return { skill, content: body };
  }

  async writeSkill(
    agentId: AgentId,
    skillId: string,
    input: SkillFileInput,
    times: { createdAt: Timestamp; updatedAt: Timestamp },
  ): Promise<StoredSkill> {
    const body = input.content ?? '';
    const document = serializeDocument(
      {
        slug: input.slug,
        name: input.name,
        kind: input.kind,
        description: input.description ?? '',
        requiredTools: [...(input.requiredTools ?? [])],
        createdAt: times.createdAt,
        updatedAt: times.updatedAt,
      },
      body,
    );
    const file = this.skillPath(agentId, skillId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, document);
    const stored = await this.readSkill(agentId, skillId);
    if (!stored) {
      throw new Error(`skill file disappeared immediately after writing it: ${skillId}`);
    }
    return stored;
  }

  async deleteSkill(agentId: AgentId, skillId: string): Promise<boolean> {
    const dir = path.dirname(this.skillPath(agentId, skillId));
    if (!fs.existsSync(dir)) {
      return false;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ── Knowledge ──────────────────────────────────────────────────

  async listKnowledge(agentId: AgentId): Promise<StoredKnowledge[]> {
    const dir = path.join(this.agentDir(agentId), KNOWLEDGE_DIR);
    const stored: StoredKnowledge[] = [];
    for (const id of listIdFiles(dir)) {
      const item = await this.readKnowledge(agentId, id);
      if (item) {
        stored.push(item);
      }
    }
    return stored.sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));
  }

  async readKnowledge(agentId: AgentId, knowledgeId: string): Promise<StoredKnowledge | null> {
    const file = this.knowledgePath(agentId, knowledgeId);
    const text = readIfPresent(file);
    if (text === null) {
      return null;
    }
    const { fields, body } = parseDocument(text);
    const item: AgentKnowledge = {
      id: asAgentKnowledgeId(knowledgeId),
      agentId,
      type: textField(fields, 'type', 'markdown') as AgentKnowledge['type'],
      title: textField(fields, 'title', knowledgeId),
      source: { origin: 'human' },
      // The file IS the content; the reference points at itself.
      location: { store: 'file', path: file },
      tags: listField(fields, 'tags'),
      metadata: {},
      createdAt: textField(fields, 'createdAt'),
      updatedAt: textField(fields, 'updatedAt'),
    };
    return { item, content: body };
  }

  async writeKnowledge(
    agentId: AgentId,
    knowledgeId: string,
    input: KnowledgeFileInput,
    times: { createdAt: Timestamp; updatedAt: Timestamp },
  ): Promise<StoredKnowledge> {
    const document = serializeDocument(
      {
        title: input.title,
        type: input.type,
        tags: [...(input.tags ?? [])],
        createdAt: times.createdAt,
        updatedAt: times.updatedAt,
      },
      input.content,
    );
    const file = this.knowledgePath(agentId, knowledgeId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, document);
    const stored = await this.readKnowledge(agentId, knowledgeId);
    if (!stored) {
      throw new Error(`knowledge file disappeared immediately after writing it: ${knowledgeId}`);
    }
    return stored;
  }

  async deleteKnowledge(agentId: AgentId, knowledgeId: string): Promise<boolean> {
    const file = this.knowledgePath(agentId, knowledgeId);
    if (!fs.existsSync(file)) {
      return false;
    }
    fs.rmSync(file);
    return true;
  }

  // ── Paths ──────────────────────────────────────────────────────

  /** Every path in this store is built here, from ids and nothing else. */
  agentDir(agentId: AgentId): string {
    return path.join(this.root, requireId(agentId, 'agent'));
  }

  private skillPath(agentId: AgentId, skillId: string): string {
    return this.within(agentId, SKILLS_DIR, requireId(skillId, 'skill'), SKILL_FILE);
  }

  private knowledgePath(agentId: AgentId, knowledgeId: string): string {
    return this.within(agentId, KNOWLEDGE_DIR, `${requireId(knowledgeId, 'knowledge')}.md`);
  }

  /**
   * Join inside the agent's directory, then prove the result is still inside
   * it. The id check above already makes escape impossible; this is the belt
   * that survives someone loosening the braces.
   */
  private within(agentId: AgentId, ...segments: string[]): string {
    const dir = this.agentDir(agentId);
    const resolved = path.resolve(dir, ...segments);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      throw new Error('refusing a path outside the agent directory');
    }
    return resolved;
  }

  private markerPath(agentId: AgentId): string {
    return this.within(agentId, AGENT_MARKER);
  }

  private readMarker(agentId: AgentId): AgentMarker | null {
    const text = readIfPresent(this.markerPath(agentId));
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text) as AgentMarker;
    } catch {
      return null;
    }
  }

  private writeMarker(agentId: AgentId, marker: AgentMarker): void {
    const file = this.markerPath(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(marker, null, 2)}\n`);
  }

  /** Agent ids with a directory on disk. Anything else in the root is ignored. */
  listAgentIds(): AgentId[] {
    return listIdDirectories(this.root).map(asAgentId);
  }
}

function requireId(value: string, what: string): string {
  if (!isCanonicalId(value)) {
    throw new Error(`refusing a ${what} id that is not a canonical uuid: ${JSON.stringify(value)}`);
  }
  return value;
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Write through a temporary file, so an interrupted write leaves the old one. */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function listIdDirectories(dir: string): string[] {
  return entries(dir)
    .filter((entry) => entry.isDirectory() && isCanonicalId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function listIdFiles(dir: string): string[] {
  return entries(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -'.md'.length))
    .filter(isCanonicalId)
    .sort();
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

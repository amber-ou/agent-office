/**
 * Agent-owned file storage — the port.
 *
 * An Agent's permanent configuration lives in its OWN directory, keyed by its
 * immutable id, not by its name: renaming an agent is an edit, not a move, and
 * a slug is a label rather than an address.
 *
 *   agents/<agent-id>/
 *     agent.json                  identity marker only
 *     office.json                 Office-only fields (never name/description/
 *                                 tools/model — those live solely in agent.md)
 *     discovery/agent.md          front matter (CC-native fields) + body
 *                                 (instructions). THE single source for both:
 *                                 Office and Claude Code read and write this
 *                                 one file. This is the ONLY file junctioned
 *                                 into `~/.claude/agents/<agent-id>/` — the
 *                                 rest of this directory is out of CC's
 *                                 discovery scope on purpose (ADR 007 update).
 *     skills/<skill-id>/SKILL.md  one skill, front matter + body
 *     knowledge/<knowledge-id>.md one knowledge item, front matter + body
 *     knowledge/index.md          generated index for on-demand reading —
 *                                 not a claim that anything auto-loads it
 *
 * These files are the AUTHORITATIVE source for instructions, skills and
 * foundational knowledge once an agent is migrated. `AgentCcFields` (name,
 * description, tools, model) and `OfficeAgentMeta` (role, provider, memory,
 * appearance, Office's own display name) are two disjoint field sets stored in
 * two places for a reason: every field has exactly one authoritative location,
 * never a second editable copy.
 *
 * Every method takes the owning `agentId`, so there is no call in this port
 * that can reach another agent's files.
 */

import type { AgentId, AgentKnowledge, Skill, Timestamp } from '../../domain/src/index.js';

/**
 * The fields Claude Code's own subagent format understands, stored in
 * `discovery/agent.md`'s front matter. This is the ONLY authoritative home
 * for these fields — office.json must never duplicate them.
 */
export interface AgentCcFields {
  /**
   * CC's own stable identifier for this agent (the subagent frontmatter
   * `name`). Set once on first write and never changed by a later
   * `writeCcFields` call — CC's own discovery and any reference to this agent
   * by name depends on it staying put, even if Office's own display name (see
   * `OfficeAgentMeta.displayName`) is renamed later.
   */
  name?: string;
  description: string;
  /** Tool names this agent may use — CC's `tools:` allow-list. */
  tools: string[];
  /** Tool names this agent may not use — CC's `disallowedTools:` list. */
  disallowedTools: string[];
  model?: string;
}

/**
 * Office-only fields with no Claude Code equivalent. Deliberately excludes
 * name, description, tools and model — those live solely in `AgentCcFields`,
 * so there is exactly one place to look for any given field.
 */
export interface OfficeAgentMeta {
  agentId: string;
  /**
   * Office's own mutable display name. Distinct from `AgentCcFields.name`:
   * renaming an agent in Office does not change CC's stable identifier for
   * it.
   */
  displayName: string;
  role: string;
  provider: string;
  memory: { notes: string; recentTaskSummaryLimit: number };
  appearance: { palette?: number; hueShift?: number };
}

/** What a skill file holds. Ids and ownership come from the path, never the body. */
export interface SkillFileInput {
  slug: string;
  name: string;
  kind: Skill['kind'];
  description?: string;
  content?: string;
  requiredTools?: readonly string[];
}

export interface KnowledgeFileInput {
  title: string;
  type: AgentKnowledge['type'];
  content: string;
  tags?: readonly string[];
}

/** A skill as stored, with its body resolved. */
export interface StoredSkill {
  skill: Skill;
  content: string;
}

export interface StoredKnowledge {
  item: AgentKnowledge;
  content: string;
}

export interface AgentFileStore {
  /** Create the agent's directory if it is missing. Idempotent. */
  ensureAgent(agentId: AgentId, now: Timestamp): Promise<void>;
  /** True once this agent's files are the authoritative source. */
  isMigrated(agentId: AgentId): Promise<boolean>;
  markMigrated(agentId: AgentId, now: Timestamp): Promise<void>;

  readInstructions(agentId: AgentId): Promise<string | null>;
  writeInstructions(agentId: AgentId, instructions: string): Promise<void>;

  /** The CC-native fields from `discovery/agent.md`'s front matter, or null
   *  if the agent has no discovery file yet. */
  readCcFields(agentId: AgentId): Promise<AgentCcFields | null>;
  /**
   * Merge CC fields into `discovery/agent.md`, preserving the body
   * (instructions) untouched. `fields.name` is honored only when no name is
   * set yet — once set, a name is sticky, so passing a different value here
   * later is silently ignored rather than treated as a rename.
   */
  writeCcFields(agentId: AgentId, fields: AgentCcFields): Promise<void>;

  /** Office-only metadata from `office.json`, or null if not written yet. */
  readOfficeMeta(agentId: AgentId): Promise<OfficeAgentMeta | null>;
  writeOfficeMeta(agentId: AgentId, meta: OfficeAgentMeta): Promise<void>;

  /**
   * Regenerate `knowledge/index.md` from the knowledge files currently on
   * disk. An index, not a loader: nothing reads every file automatically
   * because this ran.
   */
  rebuildKnowledgeIndex(agentId: AgentId): Promise<void>;

  listSkills(agentId: AgentId): Promise<StoredSkill[]>;
  readSkill(agentId: AgentId, skillId: string): Promise<StoredSkill | null>;
  writeSkill(
    agentId: AgentId,
    skillId: string,
    input: SkillFileInput,
    times: { createdAt: Timestamp; updatedAt: Timestamp },
  ): Promise<StoredSkill>;
  deleteSkill(agentId: AgentId, skillId: string): Promise<boolean>;

  listKnowledge(agentId: AgentId): Promise<StoredKnowledge[]>;
  readKnowledge(agentId: AgentId, knowledgeId: string): Promise<StoredKnowledge | null>;
  writeKnowledge(
    agentId: AgentId,
    knowledgeId: string,
    input: KnowledgeFileInput,
    times: { createdAt: Timestamp; updatedAt: Timestamp },
  ): Promise<StoredKnowledge>;
  deleteKnowledge(agentId: AgentId, knowledgeId: string): Promise<boolean>;

  /** Absolute path of the directory every agent's files live under. */
  readonly root: string;
}

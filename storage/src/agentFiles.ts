/**
 * Agent-owned file storage — the port.
 *
 * An Agent's permanent configuration lives in its OWN directory, keyed by its
 * immutable id, not by its name: renaming an agent is an edit, not a move, and
 * a slug is a label rather than an address.
 *
 *   agents/<agent-id>/
 *     agent.json                  identity marker only
 *     instructions.md             the agent's instructions (systemPrompt)
 *     skills/<skill-id>/SKILL.md  one skill, front matter + body
 *     knowledge/<knowledge-id>.md one knowledge item, front matter + body
 *
 * These files are the AUTHORITATIVE source for instructions, skills and
 * foundational knowledge once an agent is migrated. The Office database keeps
 * the agent's identity and registry metadata (name, role, provider, model) and
 * the operational state around it — never a second editable copy of what is in
 * the files.
 *
 * Every method takes the owning `agentId`, so there is no call in this port
 * that can reach another agent's files.
 */

import type { AgentId, AgentKnowledge, Skill, Timestamp } from '../../domain/src/index.js';

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

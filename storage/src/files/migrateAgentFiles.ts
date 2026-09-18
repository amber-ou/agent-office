/**
 * Moving Agent-owned configuration out of the database and into files.
 *
 * The rules this migration is built around:
 *
 *  - Nothing legacy is deleted or rewritten. The rows and blobs stay exactly as
 *    they are, so the whole change is undone by deleting the agents directory.
 *  - A file that already exists is never overwritten. If its content differs
 *    from the row's, that is a CONFLICT: both copies are kept, the conflict is
 *    reported, and that agent is left reading the database until a person
 *    decides.
 *  - The authoritative read path switches per agent, and only after every one
 *    of that agent's resources has been written AND read back identical.
 *  - Rerunning is a no-op. An interrupted run resumes: whatever was written
 *    matches and is skipped, whatever was not is written now, and the agent is
 *    marked only once the whole set validates.
 *  - **An agent that has already moved is never written from the database
 *    again.** Completion is recorded in the database, not only in the agent's
 *    own directory, so a lost or emptied directory reads as DAMAGE to repair
 *    from a backup — not as an agent that never moved, and never as a silent
 *    rebuild of whatever the legacy rows still happen to say. Deleting a
 *    migrated skill is a normal edit; resurrecting it would be data loss in
 *    the other direction.
 */

import type {
  AgentDefinition,
  AgentId,
  Repositories,
  Timestamp,
} from '../../../domain/src/index.js';
import type { AgentFileStore } from '../agentFiles.js';
import type { AgentMigrationStore } from '../sqlite/agentMigrations.js';

export interface MigrationConflict {
  agentId: AgentId;
  /** 'instructions' | 'skill' | 'knowledge' */
  resource: string;
  resourceId?: string;
  detail: string;
}

export interface AgentMigrationReport {
  /** Agents whose files are now authoritative, including ones already done. */
  migrated: AgentId[];
  /** Agents left on the database because something needs a person. */
  blocked: AgentId[];
  /**
   * Agents the database says are file-backed whose files are missing or
   * unreadable. Nothing is rebuilt for them: the fix is restoring the backup.
   */
  damaged: AgentId[];
  conflicts: MigrationConflict[];
  /** Resources written by this run. Empty on a second run. */
  written: number;
}

/**
 * Run the migration for every agent in the database.
 *
 * `now` is passed in rather than read, so a test can pin it and two runs of
 * this function are comparable.
 */
export async function migrateAgentFiles(
  repos: Repositories,
  files: AgentFileStore,
  state: AgentMigrationStore,
  now: Timestamp,
): Promise<AgentMigrationReport> {
  const report: AgentMigrationReport = {
    migrated: [],
    blocked: [],
    damaged: [],
    conflicts: [],
    written: 0,
  };

  for (const agent of await repos.agents.list()) {
    if (await state.isMigrated(agent.id)) {
      // Already handed over. Whatever the legacy rows still hold is history,
      // and the only question left is whether the files are still there.
      if ((await files.readInstructions(agent.id)) === null) {
        report.damaged.push(agent.id);
        report.conflicts.push({
          agentId: agent.id,
          resource: 'instructions',
          detail:
            'this agent is file-backed but its files are missing or unreadable; nothing was rebuilt from the database — restore the agents directory from a backup',
        });
        continue;
      }
      // The in-directory marker is a convenience copy; restore it if it was
      // the only thing lost. No content is written.
      if (!(await files.isMigrated(agent.id))) {
        await files.markMigrated(agent.id, now);
      }
      report.migrated.push(agent.id);
      continue;
    }
    await files.ensureAgent(agent.id, now);
    const before = report.conflicts.length;
    report.written += await migrateOneAgent(agent, repos, files, report, now);

    if (report.conflicts.length > before) {
      // Something differs. Both copies stay; this agent keeps reading the
      // database until a person resolves it.
      report.blocked.push(agent.id);
      continue;
    }
    await files.markMigrated(agent.id, now);
    await state.markMigrated(agent.id, now);
    report.migrated.push(agent.id);
  }

  return report;
}

async function migrateOneAgent(
  agent: AgentDefinition,
  repos: Repositories,
  files: AgentFileStore,
  report: AgentMigrationReport,
  now: Timestamp,
): Promise<number> {
  let written = 0;

  // ── Instructions ──
  const existingInstructions = await files.readInstructions(agent.id);
  if (existingInstructions === null) {
    await files.writeInstructions(agent.id, agent.systemPrompt);
    written++;
  } else if (existingInstructions !== agent.systemPrompt) {
    report.conflicts.push({
      agentId: agent.id,
      resource: 'instructions',
      detail: 'instructions.md differs from the stored systemPrompt; neither was changed',
    });
  }

  // ── Skills ──
  for (const skill of await repos.skills.listByAgent(agent.id)) {
    const body =
      skill.source.origin === 'content' && skill.source.ref.store === 'inline'
        ? skill.source.ref.content
        : '';
    const existing = await files.readSkill(agent.id, skill.id);
    if (!existing) {
      await files.writeSkill(
        agent.id,
        skill.id,
        {
          slug: skill.slug,
          name: skill.name,
          kind: skill.kind,
          description: skill.description,
          content: body,
          requiredTools: skill.requiredTools,
        },
        { createdAt: skill.createdAt, updatedAt: skill.updatedAt },
      );
      written++;
      continue;
    }
    if (existing.content !== body || existing.skill.name !== skill.name) {
      report.conflicts.push({
        agentId: agent.id,
        resource: 'skill',
        resourceId: skill.id,
        detail: `SKILL.md differs from the stored skill "${skill.slug}"; neither was changed`,
      });
    }
  }

  // ── Foundational knowledge ──
  for (const item of await repos.agentKnowledge.listByAgent(agent.id)) {
    let content: string;
    try {
      content = await repos.blobs.read(item.location);
    } catch {
      // The blob is gone or is a reference this build cannot read. Writing an
      // empty file would look like a successful migration of nothing.
      report.conflicts.push({
        agentId: agent.id,
        resource: 'knowledge',
        resourceId: item.id,
        detail: `the stored content of "${item.title}" could not be read; nothing was written`,
      });
      continue;
    }
    const existing = await files.readKnowledge(agent.id, item.id);
    if (!existing) {
      await files.writeKnowledge(
        agent.id,
        item.id,
        { title: item.title, type: item.type, content, tags: item.tags },
        { createdAt: item.createdAt, updatedAt: item.updatedAt },
      );
      written++;
      continue;
    }
    if (existing.content !== content || existing.item.title !== item.title) {
      report.conflicts.push({
        agentId: agent.id,
        resource: 'knowledge',
        resourceId: item.id,
        detail: `${item.id}.md differs from the stored knowledge "${item.title}"; neither was changed`,
      });
    }
  }

  // ── Validate what we just wrote, before anything reads from it ──
  await validate(agent, repos, files, report, now);
  return written;
}

/**
 * Read every resource back through the file store and check it against the
 * database. A write that did not land, or landed under the wrong owner, must
 * stop this agent from switching over.
 */
async function validate(
  agent: AgentDefinition,
  repos: Repositories,
  files: AgentFileStore,
  report: AgentMigrationReport,
  _now: Timestamp,
): Promise<void> {
  const instructions = await files.readInstructions(agent.id);
  if (instructions === null) {
    report.conflicts.push({
      agentId: agent.id,
      resource: 'instructions',
      detail: 'instructions.md is missing after migration',
    });
  }

  const skills = await files.listSkills(agent.id);
  for (const stored of skills) {
    if (stored.skill.agentId !== agent.id) {
      report.conflicts.push({
        agentId: agent.id,
        resource: 'skill',
        resourceId: stored.skill.id,
        detail: 'a skill file resolved to a different owner',
      });
    }
  }
  const rowSkillIds = new Set((await repos.skills.listByAgent(agent.id)).map((s) => s.id));
  const fileSkillIds = new Set(skills.map((s) => s.skill.id));
  for (const id of rowSkillIds) {
    if (!fileSkillIds.has(id)) {
      report.conflicts.push({
        agentId: agent.id,
        resource: 'skill',
        resourceId: id,
        detail: 'the stored skill has no file after migration',
      });
    }
  }

  const knowledge = await files.listKnowledge(agent.id);
  for (const stored of knowledge) {
    if (stored.item.agentId !== agent.id) {
      report.conflicts.push({
        agentId: agent.id,
        resource: 'knowledge',
        resourceId: stored.item.id,
        detail: 'a knowledge file resolved to a different owner',
      });
    }
  }
  const fileKnowledgeIds = new Set(knowledge.map((k) => k.item.id));
  for (const item of await repos.agentKnowledge.listByAgent(agent.id)) {
    if (!fileKnowledgeIds.has(item.id)) {
      report.conflicts.push({
        agentId: agent.id,
        resource: 'knowledge',
        resourceId: item.id,
        detail: 'the stored knowledge has no file after migration',
      });
    }
  }
}

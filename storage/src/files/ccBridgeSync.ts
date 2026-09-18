/**
 * Keeps every file-backed agent's Claude Code discovery surface up to date:
 * `discovery/agent.md`'s CC fields, `office.json`, the knowledge index, each
 * skill's globally-unique name, and the directory links into
 * `~/.claude/agents/` and `~/.claude/skills/`.
 *
 * Safe to call repeatedly — every write is idempotent, and an agent or skill
 * whose file has an unresolved git conflict marker is reported as damaged and
 * never linked or synced, so a broken merge can never end up looking like a
 * runnable agent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentId, Repositories, Timestamp } from '../../../domain/src/index.js';
import type { AgentFileStore } from '../agentFiles.js';
import type { AgentMigrationStore } from '../sqlite/agentMigrations.js';
import {
  ccFieldsFromAgent,
  ccIdentifierFor,
  officeMetaFromAgent,
  qualifiedSkillName,
  validateBridgeFile,
} from './ccBridge.js';
import { ensureDirectoryLink } from './discoveryLinks.js';

export interface AgentDiscoveryPaths {
  /** Usually `~/.claude/agents`. */
  claudeAgentsRoot: string;
  /** Usually `~/.claude/skills`. */
  claudeSkillsRoot: string;
}

export interface CcBridgeDamage {
  agentId: AgentId;
  resource: 'agent' | 'skill';
  resourceId?: string;
  reason: string;
}

export interface CcBridgeSyncReport {
  synced: AgentId[];
  damaged: CcBridgeDamage[];
  linksCreated: number;
  skippedForeignLinks: string[];
}

export async function syncCcBridge(
  repos: Repositories,
  files: AgentFileStore,
  migrations: AgentMigrationStore,
  paths: AgentDiscoveryPaths,
  _now: Timestamp,
): Promise<CcBridgeSyncReport> {
  const report: CcBridgeSyncReport = {
    synced: [],
    damaged: [],
    linksCreated: 0,
    skippedForeignLinks: [],
  };

  for (const agent of await repos.agents.list()) {
    if (!(await migrations.isMigrated(agent.id))) {
      continue; // still database-backed; the discovery bridge is file-only
    }

    const rawAgentMd = readIfPresent(path.join(files.root, agent.id, 'discovery', 'agent.md'));
    if (rawAgentMd === null) {
      // A migrated agent with no file at all — a deleted directory, a bad
      // restore, a stray rm. Never write anything for it: that would silently
      // resurrect a damaged agent with fresh, empty content instead of
      // leaving the damage visible for a person to repair from a backup (see
      // migrateAgentFiles's own "damaged" handling, which this mirrors).
      report.damaged.push({
        agentId: agent.id,
        resource: 'agent',
        reason: 'discovery/agent.md is missing',
      });
      continue;
    }
    const validation = validateBridgeFile(rawAgentMd);
    if (!validation.ok) {
      report.damaged.push({ agentId: agent.id, resource: 'agent', reason: validation.reason! });
      continue; // never link or run an agent whose file is mid-conflict
    }

    const existingCc = await files.readCcFields(agent.id);
    const ccIdentifier = existingCc?.name ?? ccIdentifierFor(agent.role, agent.id);
    await files.writeCcFields(agent.id, ccFieldsFromAgent(agent, ccIdentifier));
    await files.writeOfficeMeta(agent.id, officeMetaFromAgent(agent));
    await files.rebuildKnowledgeIndex(agent.id);

    const discoveryDir = path.join(files.root, agent.id, 'discovery');
    const agentLink = path.join(paths.claudeAgentsRoot, agent.id);
    const agentOutcome = ensureDirectoryLink(agentLink, discoveryDir);
    if (agentOutcome.skippedForeign) {
      report.skippedForeignLinks.push(agentLink);
    } else if (agentOutcome.created) {
      report.linksCreated++;
    }

    for (const skill of await repos.skills.listByAgent(agent.id)) {
      const stored = await files.readSkill(agent.id, skill.id);
      if (!stored) {
        continue; // migration has not written this skill's file yet
      }
      const rawSkill = readIfPresent(
        path.join(files.root, agent.id, 'skills', skill.id, 'SKILL.md'),
      );
      if (rawSkill !== null) {
        const validation = validateBridgeFile(rawSkill);
        if (!validation.ok) {
          report.damaged.push({
            agentId: agent.id,
            resource: 'skill',
            resourceId: skill.id,
            reason: validation.reason!,
          });
          continue;
        }
      }

      const qualified = qualifiedSkillName(ccIdentifier, stored.skill.slug);
      if (stored.skill.name !== qualified) {
        await files.writeSkill(
          agent.id,
          skill.id,
          {
            slug: stored.skill.slug,
            name: qualified,
            kind: stored.skill.kind,
            description: stored.skill.description,
            content: stored.content,
            requiredTools: stored.skill.requiredTools,
          },
          { createdAt: stored.skill.createdAt, updatedAt: stored.skill.updatedAt },
        );
      }

      const skillDir = path.join(files.root, agent.id, 'skills', skill.id);
      const skillLink = path.join(paths.claudeSkillsRoot, qualified);
      const skillOutcome = ensureDirectoryLink(skillLink, skillDir);
      if (skillOutcome.skippedForeign) {
        report.skippedForeignLinks.push(skillLink);
      } else if (skillOutcome.created) {
        report.linksCreated++;
      }
    }

    report.synced.push(agent.id);
  }

  return report;
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

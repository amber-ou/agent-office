/**
 * Bootstraps a database that has never seen an agent whose files already
 * exist on disk — the "second computer" case: `git clone` populated
 * `~/.agent-office/agents/`, but the SQLite registry here is empty (or just
 * missing that agent), so there is no database row to hand over TO. This is
 * the mirror image of `migrateAgentFiles` (database → files); this module
 * goes files → database, and only for an agent id the database does not
 * already have.
 *
 * Never invents content: an agent directory missing `office.json`,
 * `discovery/agent.md`, or its CC fields, or one whose `agent.md` has an
 * unresolved git conflict marker, is reported as damaged and left
 * unregistered rather than guessed at.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentDefinition,
  AgentId,
  Repositories,
  Timestamp,
} from '../../../domain/src/index.js';
import { asAgentId, isCanonicalId } from '../../../domain/src/index.js';
import type { AgentFileStore } from '../agentFiles.js';
import type { AgentMigrationStore } from '../sqlite/agentMigrations.js';
import { toolGrantsFromCcFields, validateBridgeFile } from './ccBridge.js';

export interface ImportAgentsReport {
  imported: AgentId[];
  alreadyRegistered: AgentId[];
  damaged: { agentId: AgentId; reason: string }[];
}

export async function importAgentsFromDisk(
  repos: Repositories,
  files: AgentFileStore,
  migrations: AgentMigrationStore,
  now: Timestamp,
): Promise<ImportAgentsReport> {
  const report: ImportAgentsReport = { imported: [], alreadyRegistered: [], damaged: [] };

  for (const rawId of listAgentDirectories(files.root)) {
    const agentId = asAgentId(rawId);
    if ((await repos.agents.get(agentId)) !== null) {
      report.alreadyRegistered.push(agentId);
      continue;
    }

    const marker = readJsonIfPresent<{ id: string; createdAt: Timestamp }>(
      path.join(files.root, rawId, 'agent.json'),
    );
    if (!marker) {
      report.damaged.push({ agentId, reason: 'agent.json is missing or unreadable' });
      continue;
    }

    const rawAgentMd = readIfPresent(path.join(files.root, rawId, 'discovery', 'agent.md'));
    if (rawAgentMd === null) {
      report.damaged.push({ agentId, reason: 'discovery/agent.md is missing' });
      continue;
    }
    const validation = validateBridgeFile(rawAgentMd);
    if (!validation.ok) {
      report.damaged.push({ agentId, reason: validation.reason! });
      continue;
    }

    const officeMeta = await files.readOfficeMeta(agentId);
    if (!officeMeta) {
      report.damaged.push({ agentId, reason: 'office.json is missing or unreadable' });
      continue;
    }
    const ccFields = await files.readCcFields(agentId);
    if (!ccFields) {
      report.damaged.push({ agentId, reason: 'discovery/agent.md has no readable CC fields' });
      continue;
    }
    const instructions = (await files.readInstructions(agentId)) ?? '';

    const agent: AgentDefinition = {
      id: agentId,
      name: officeMeta.displayName,
      role: officeMeta.role,
      description: ccFields.description,
      systemPrompt: instructions,
      provider: officeMeta.provider,
      model: ccFields.model,
      tools: toolGrantsFromCcFields(ccFields),
      memory: { ...officeMeta.memory },
      appearance: { ...officeMeta.appearance },
      createdAt: marker.createdAt,
      updatedAt: now,
    };

    await repos.agents.put(agent);
    await migrations.markMigrated(agentId, now);
    await files.markMigrated(agentId, now);
    report.imported.push(agentId);
  }

  return report;
}

function listAgentDirectories(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isCanonicalId(entry.name))
    .map((entry) => entry.name)
    .sort();
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

function readJsonIfPresent<T>(file: string): T | null {
  const text = readIfPresent(file);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

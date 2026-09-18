/**
 * One-time backfill for agents that migrated to files BEFORE the Claude Code
 * discovery bridge existed.
 *
 * Before this bridge, `readInstructions`/`writeInstructions` targeted a flat
 * `instructions.md`. They now target `discovery/agent.md` (see
 * `agentFiles.ts` and `fileAgentStore.ts`) — the single file both Office and
 * Claude Code read and write. Without this step, every already-migrated
 * agent's instructions would read back as missing the moment this ships,
 * which `contextAssembly.ts` treats as damage and refuses to run tasks from.
 *
 * Idempotent, restart-safe, and never destructive:
 *
 *  - the legacy file is copied to `instructions.md.bak`, never deleted;
 *  - if `discovery/agent.md` already has a body that differs from the legacy
 *    file, that is a conflict: neither is touched;
 *  - an agent with neither file is left for the existing migration/bridge
 *    reporting to flag as damaged — this function does not invent content.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentId, Repositories, Timestamp } from '../../../domain/src/index.js';
import type { AgentFileStore } from '../agentFiles.js';
import type { AgentMigrationStore } from '../sqlite/agentMigrations.js';

const LEGACY_INSTRUCTIONS_FILE = 'instructions.md';
const LEGACY_BACKUP_SUFFIX = '.bak';

export interface CcBridgeBackfillReport {
  backfilled: AgentId[];
  alreadyDone: AgentId[];
  conflicts: { agentId: AgentId; detail: string }[];
  /** Neither the legacy file nor the new one exists. Not this function's to
   *  fix — the agent-file migration/damage reporting already covers it. */
  damaged: AgentId[];
}

export async function backfillCcBridge(
  repos: Repositories,
  files: AgentFileStore,
  migrations: AgentMigrationStore,
  _now: Timestamp,
): Promise<CcBridgeBackfillReport> {
  const report: CcBridgeBackfillReport = {
    backfilled: [],
    alreadyDone: [],
    conflicts: [],
    damaged: [],
  };

  for (const agent of await repos.agents.list()) {
    if (!(await migrations.isMigrated(agent.id))) {
      continue; // still database-backed; nothing to backfill
    }

    const legacyPath = path.join(files.root, agent.id, LEGACY_INSTRUCTIONS_FILE);
    const legacyText = readIfPresent(legacyPath);
    const currentBody = await files.readInstructions(agent.id);

    if (legacyText === null) {
      report[currentBody === null ? 'damaged' : 'alreadyDone'].push(agent.id);
      continue;
    }
    if (currentBody !== null) {
      if (currentBody === legacyText) {
        report.alreadyDone.push(agent.id);
      } else {
        report.conflicts.push({
          agentId: agent.id,
          detail:
            'discovery/agent.md already has a body that differs from the legacy instructions.md; neither was changed',
        });
      }
      continue;
    }

    const backupPath = `${legacyPath}${LEGACY_BACKUP_SUFFIX}`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(legacyPath, backupPath);
    }
    await files.writeInstructions(agent.id, legacyText);
    report.backfilled.push(agent.id);
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

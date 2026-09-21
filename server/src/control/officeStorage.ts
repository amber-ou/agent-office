/**
 * The one place the server opens the Agent Office database.
 *
 * Lazily opened on first use and held for the life of the process, so both
 * surfaces (VS Code webview and standalone CLI) get persistence without either
 * entry point having to know about it.
 *
 * Opening is allowed to fail — a read-only home directory, a corrupt file, a
 * schema newer than this build. A failure is recorded and reported to the UI as
 * `storage.ready: false` rather than thrown at whatever happened to ask first:
 * the office still renders, it just cannot persist.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { Repositories, UnitOfWork } from '../../../domain/src/index.js';
import { systemClock } from '../../../domain/src/index.js';
import type {
  AgentDiscoveryPaths,
  AgentFileStore,
  AgentMigrationReport,
  AgentMigrationStore,
  CcBridgeBackfillReport,
  CcBridgeSyncReport,
  ImportAgentsReport,
  ReviewNoteStore,
  SqliteStorage,
} from '../../../storage/src/index.js';
import {
  backfillCcBridge,
  importAgentsFromDisk,
  LATEST_SCHEMA_VERSION,
  migrateAgentFiles,
  openSqliteStorage,
  syncCcBridge,
} from '../../../storage/src/index.js';
import { resetTaskRunner } from './taskRunner.js';

/** Where Claude Code looks for its own agents/skills — see ADR 007's bridge
 *  update. Overridable for tests, the same way `dataRootOverride` is. */
function defaultClaudeDiscoveryPaths(): AgentDiscoveryPaths {
  const claudeRoot = path.join(os.homedir(), '.claude');
  return {
    claudeAgentsRoot: path.join(claudeRoot, 'agents'),
    claudeSkillsRoot: path.join(claudeRoot, 'skills'),
  };
}

export interface OfficeStorage {
  repos: Repositories;
  uow: UnitOfWork;
  /** Human review notes — an application record, not a domain repository. */
  reviews: ReviewNoteStore;
  /** Agent-owned files: instructions, skills, foundational knowledge. */
  agentFiles: AgentFileStore;
  /** Which agents have moved to files. Durable, and not inside those files. */
  agentMigrations: AgentMigrationStore;
  /** Where the Claude Code discovery bridge links into — same value the
   *  boot-time sync uses, so a mutation-triggered sync (see officeService.ts)
   *  never targets a different place. */
  ccDiscoveryPaths: AgentDiscoveryPaths;
  /** The data root, and the per-run scratch tree inside it. */
  dataRoot: string;
  runtimeRoot: string;
  databasePath: string;
  schemaVersion: number;
}

export interface OfficeStorageStatusSnapshot {
  ready: boolean;
  schemaVersion: number;
  databasePath?: string;
  error?: string;
}

let opened: SqliteStorage | null = null;
let openError: string | null = null;
/** The in-flight (or finished) migration for the currently open database. */
let migrationRun: Promise<AgentMigrationReport | null> | null = null;
/** Runs right after migration: legacy instructions.md → discovery/agent.md,
 *  then imports any agent whose files exist but has no database row yet
 *  (the second-computer case), then syncs the Claude Code discovery links. */
let ccBridgeRun: Promise<CcBridgeRunResult | null> | null = null;
/** Set by tests; also the seam a future multi-root setup would use. */
let dataRootOverride: string | undefined;
/** Set by tests. Production always uses `~/.claude/agents` + `~/.claude/skills`. */
let claudeDiscoveryPathsOverride: AgentDiscoveryPaths | undefined;

/** Point the office at a different data root. Closes anything already open. */
export function setOfficeDataRoot(dataRoot: string | undefined): void {
  closeOfficeStorage();
  dataRootOverride = dataRoot;
}

/** Point the Claude Code discovery bridge at different `agents`/`skills`
 *  roots than the real `~/.claude/`. Closes anything already open. */
export function setClaudeDiscoveryPaths(paths: AgentDiscoveryPaths | undefined): void {
  closeOfficeStorage();
  claudeDiscoveryPathsOverride = paths;
}

export function getOfficeStorage(): OfficeStorage | null {
  if (opened) {
    return toOfficeStorage(opened);
  }
  if (openError !== null) {
    return null;
  }
  try {
    const storage = openSqliteStorage(dataRootOverride ? { dataRoot: dataRootOverride } : {});
    opened = storage;
    console.log(
      `[Agent Office] Storage ready: ${storage.databasePath} (schema v${storage.schemaVersion})`,
    );
    // Agent configuration moves into per-agent files. Idempotent, non-destructive,
    // and it switches an agent over only once everything of that agent's
    // validates — so a failure here leaves the database authoritative rather
    // than leaving the office unusable. `storage` (not the module-level
    // `opened`) is captured here, so a `closeOfficeStorage()` racing this
    // chain can never repoint it mid-flight onto a different database.
    migrationRun = runAgentFileMigration(storage);
    ccBridgeRun = migrationRun.then(() => runCcBridge(storage));
    return toOfficeStorage(storage);
  } catch (error) {
    openError = error instanceof Error ? error.message : String(error);
    console.error(`[Agent Office] Storage unavailable: ${openError}`);
    return null;
  }
}

function toOfficeStorage(storage: SqliteStorage): OfficeStorage {
  return {
    repos: storage.repos,
    uow: storage.uow,
    reviews: storage.reviews,
    agentFiles: storage.agentFiles,
    agentMigrations: storage.agentMigrations,
    ccDiscoveryPaths: claudeDiscoveryPathsOverride ?? defaultClaudeDiscoveryPaths(),
    dataRoot: storage.dataRoot,
    runtimeRoot: storage.runtimeRoot,
    databasePath: storage.databasePath,
    schemaVersion: storage.schemaVersion,
  };
}

async function runAgentFileMigration(storage: SqliteStorage): Promise<AgentMigrationReport | null> {
  try {
    const report = await migrateAgentFiles(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      systemClock.now(),
    );
    if (report.written > 0) {
      console.log(
        `[Agent Office] Migrated ${report.written} agent resource(s) to files under ${storage.agentFiles.root}`,
      );
    }
    for (const conflict of report.conflicts) {
      console.warn(
        `[Agent Office] Agent file conflict (${conflict.resource}${
          conflict.resourceId ? ` ${conflict.resourceId}` : ''
        }) for agent ${conflict.agentId}: ${conflict.detail}`,
      );
    }
    if (report.blocked.length > 0) {
      console.warn(
        `[Agent Office] ${report.blocked.length} agent(s) still read from the database until the conflicts above are resolved.`,
      );
    }
    if (report.damaged.length > 0) {
      console.error(
        `[Agent Office] ${report.damaged.length} file-backed agent(s) have missing or unreadable files. Nothing was rebuilt from the database; restore the agents directory from a backup.`,
      );
    }
    return report;
  } catch (error) {
    console.error('[Agent Office] Agent file migration failed:', error);
    return null;
  }
}

interface CcBridgeRunResult {
  imported: ImportAgentsReport;
  backfill: CcBridgeBackfillReport;
  sync: CcBridgeSyncReport;
}

/**
 * Files → database import (second-computer bootstrap), then the legacy
 * instructions.md → discovery/agent.md backfill, then the Claude Code
 * discovery sync. In that order: an agent must have a database row before
 * either of the other two steps has anything to read.
 */
async function runCcBridge(storage: SqliteStorage): Promise<CcBridgeRunResult | null> {
  try {
    const now = systemClock.now();
    const imported = await importAgentsFromDisk(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      now,
    );
    if (imported.imported.length > 0) {
      console.log(
        `[Agent Office] Registered ${imported.imported.length} agent(s) found on disk with no database row (second-computer bootstrap).`,
      );
    }
    for (const damage of imported.damaged) {
      console.warn(
        `[Agent Office] Could not import agent ${damage.agentId} from disk: ${damage.reason}`,
      );
    }

    const backfill = await backfillCcBridge(
      storage.repos,
      storage.agentFiles,
      storage.agentMigrations,
      now,
    );
    if (backfill.backfilled.length > 0) {
      console.log(
        `[Agent Office] Moved ${backfill.backfilled.length} agent(s) from legacy instructions.md to discovery/agent.md.`,
      );
    }
    for (const conflict of backfill.conflicts) {
      console.warn(
        `[Agent Office] CC bridge backfill conflict for agent ${conflict.agentId}: ${conflict.detail}`,
      );
    }

    const sync = await runCcBridgeSync(toOfficeStorage(storage));
    return sync ? { imported, backfill, sync } : null;
  } catch (error) {
    console.error('[Agent Office] Claude Code discovery bridge failed:', error);
    return null;
  }
}

/**
 * Serializes every `syncCcBridge` call — the boot-time pass and every
 * mutation-triggered call from `officeService.ts` alike — so two calls can
 * never race on the same `discovery/agent.md`. `writeCcFields` and the
 * knowledge-pointer append are each their own read-then-write; without this,
 * an overlapping call can win a lost-update race and silently drop the
 * other's write (observed: the knowledge pointer missing when a mutation
 * landed within the boot-time pass's own window).
 */
let bridgeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const result = bridgeQueue.then(run, run);
  bridgeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Runs the Claude Code discovery sync for an already-open storage, queued
 * behind every other in-flight sync for the SAME process. Call this after
 * any write to an agent's files — `officeService.ts` does, after every
 * command that touches `this.files` — not only at boot.
 */
export async function runCcBridgeSync(storage: OfficeStorage): Promise<CcBridgeSyncReport | null> {
  return serialized(async () => {
    try {
      const sync = await syncCcBridge(
        storage.repos,
        storage.agentFiles,
        storage.agentMigrations,
        storage.ccDiscoveryPaths,
        systemClock.now(),
      );
      if (sync.linksCreated > 0) {
        console.log(`[Agent Office] Created ${sync.linksCreated} Claude Code discovery link(s).`);
      }
      for (const damage of sync.damaged) {
        console.warn(
          `[Agent Office] Claude Code discovery bridge: ${damage.resource} ${
            damage.resourceId ?? damage.agentId
          } is damaged (${damage.reason}) and was not linked.`,
        );
      }
      for (const skipped of sync.skippedForeignLinks) {
        console.warn(
          `[Agent Office] Claude Code discovery bridge left ${skipped} alone — it is not a link this bridge created.`,
        );
      }
      for (const failure of sync.linkFailures) {
        console.error(
          `[Agent Office] Claude Code discovery bridge could not create a link at ${failure.path} (${failure.reason}). ` +
            `${failure.resource} ${failure.resourceId ?? failure.agentId} is not discoverable by Claude Code until this is resolved.`,
        );
      }
      return sync;
    } catch (error) {
      console.error('[Agent Office] Claude Code discovery bridge sync failed:', error);
      return null;
    }
  });
}

/**
 * Wait for the agent-file migration of the open database.
 *
 * Anything that reads or writes agent configuration awaits this first, so no
 * caller can see a half-migrated agent: until it resolves, an agent's
 * authoritative source is still the database.
 */
export async function awaitAgentFileMigration(): Promise<AgentMigrationReport | null> {
  return migrationRun ?? null;
}

/** Wait for the Claude Code discovery bridge (import + backfill + sync) of
 *  the open database. Tests that assert on discovery links or an imported
 *  agent's registration should await this first. */
export async function awaitCcBridge(): Promise<CcBridgeRunResult | null> {
  return ccBridgeRun ?? null;
}

export function officeStorageStatus(): OfficeStorageStatusSnapshot {
  const storage = getOfficeStorage();
  if (!storage) {
    return {
      ready: false,
      schemaVersion: LATEST_SCHEMA_VERSION,
      ...(openError ? { error: openError } : {}),
    };
  }
  return {
    ready: true,
    schemaVersion: storage.schemaVersion,
    databasePath: storage.databasePath,
  };
}

/** Close the database and forget any recorded failure. Used on shutdown and by tests. */
export function closeOfficeStorage(): void {
  // The task runner holds this database's repositories; it must not outlive it.
  resetTaskRunner();
  opened?.close();
  opened = null;
  openError = null;
  migrationRun = null;
  ccBridgeRun = null;
}

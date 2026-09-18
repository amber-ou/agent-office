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

import type { Repositories, UnitOfWork } from '../../../domain/src/index.js';
import { systemClock } from '../../../domain/src/index.js';
import type {
  AgentFileStore,
  AgentMigrationReport,
  ReviewNoteStore,
  SqliteStorage,
} from '../../../storage/src/index.js';
import {
  LATEST_SCHEMA_VERSION,
  migrateAgentFiles,
  openSqliteStorage,
} from '../../../storage/src/index.js';
import { resetTaskRunner } from './taskRunner.js';

export interface OfficeStorage {
  repos: Repositories;
  uow: UnitOfWork;
  /** Human review notes — an application record, not a domain repository. */
  reviews: ReviewNoteStore;
  /** Agent-owned files: instructions, skills, foundational knowledge. */
  agentFiles: AgentFileStore;
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
/** Set by tests; also the seam a future multi-root setup would use. */
let dataRootOverride: string | undefined;

/** Point the office at a different data root. Closes anything already open. */
export function setOfficeDataRoot(dataRoot: string | undefined): void {
  closeOfficeStorage();
  dataRootOverride = dataRoot;
}

export function getOfficeStorage(): OfficeStorage | null {
  if (opened) {
    return toOfficeStorage(opened);
  }
  if (openError !== null) {
    return null;
  }
  try {
    opened = openSqliteStorage(dataRootOverride ? { dataRoot: dataRootOverride } : {});
    console.log(
      `[Agent Office] Storage ready: ${opened.databasePath} (schema v${opened.schemaVersion})`,
    );
    // Agent configuration moves into per-agent files. Idempotent, non-destructive,
    // and it switches an agent over only once everything of that agent's
    // validates — so a failure here leaves the database authoritative rather
    // than leaving the office unusable.
    migrationRun = runAgentFileMigration(opened);
    return toOfficeStorage(opened);
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
    databasePath: storage.databasePath,
    schemaVersion: storage.schemaVersion,
  };
}

async function runAgentFileMigration(storage: SqliteStorage): Promise<AgentMigrationReport | null> {
  try {
    const report = await migrateAgentFiles(storage.repos, storage.agentFiles, systemClock.now());
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
    return report;
  } catch (error) {
    console.error('[Agent Office] Agent file migration failed:', error);
    return null;
  }
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
}

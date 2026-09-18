/**
 * Opening the local SQLite store.
 *
 * `openSqliteStorage()` is the whole entry point: it creates the data root if
 * it is missing, opens (or creates) the database file, migrates it to the
 * current schema, and returns the repositories plus a UnitOfWork over them.
 *
 * A fresh database is an EMPTY one. Nothing is inserted at initialisation — no
 * agents, no skills, no knowledge, no projects, no prompts. Agent Office starts
 * empty and is filled by its operator.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Repositories, UnitOfWork } from '../../../domain/src/index.js';
import type { AgentFileStore } from '../agentFiles.js';
import { AGENTS_DIR_NAME, FileAgentStore } from '../files/fileAgentStore.js';
import type { ReviewNoteStore } from '../reviewNotes.js';
import { SqliteDatabase } from './database.js';
import { FileBlobStore } from './fileBlobStore.js';
import type { Migration } from './migrations.js';
import { LATEST_SCHEMA_VERSION, migrate } from './migrations.js';
import {
  SqliteAgentKnowledgeRepository,
  SqliteAgentRepository,
  SqliteAgentSessionRepository,
  SqliteOutputRepository,
  SqliteProjectAgentRepository,
  SqliteProjectKnowledgeRepository,
  SqliteProjectRepository,
  SqliteSkillRepository,
  SqliteTaskRepository,
} from './repositories.js';
import { SqliteReviewNoteStore } from './reviewNotes.js';
import { SqliteUnitOfWork } from './unitOfWork.js';

export const DEFAULT_DATA_DIR_NAME = '.agent-office';
export const DATABASE_FILE_NAME = 'agent-office.db';
export const BLOBS_DIR_NAME = 'blobs';

/** `~/.agent-office` — deliberately separate from upstream's `~/.pixel-agents`. */
export function defaultDataRoot(): string {
  return path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
}

export interface OpenSqliteStorageOptions {
  /** Directory holding the database and the blob tree. Defaults to `~/.agent-office`. */
  dataRoot?: string;
  /**
   * Override the database file path. `:memory:` gives an ephemeral database —
   * useful for tests that want real SQL without touching disk. Blobs still need
   * a directory, so `dataRoot` is used for those either way.
   */
  databasePath?: string;
}

export interface SqliteStorage {
  repos: Repositories;
  uow: UnitOfWork;
  /**
   * Human review notes. Beside the domain repositories rather than inside
   * `Repositories`, because it is an application record and the frozen domain
   * port stays as it is.
   */
  reviews: ReviewNoteStore;
  /**
   * Agent-owned files: instructions, skills and foundational knowledge. The
   * authoritative source for those, once an agent has been migrated.
   */
  agentFiles: AgentFileStore;
  db: SqliteDatabase;
  /** Where the database and blobs live. */
  dataRoot: string;
  databasePath: string;
  /** Schema version the file is at after opening. */
  schemaVersion: number;
  /** Migrations this call applied. Empty when the file was already current. */
  applied: readonly Migration[];
  close(): void;
}

export function openSqliteStorage(options: OpenSqliteStorageOptions = {}): SqliteStorage {
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  const databasePath = options.databasePath ?? path.join(dataRoot, DATABASE_FILE_NAME);
  const blobRoot = path.join(dataRoot, BLOBS_DIR_NAME);

  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(blobRoot, { recursive: true });
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new SqliteDatabase({ path: databasePath });
  let applied: readonly Migration[];
  try {
    applied = migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const blobs = new FileBlobStore(blobRoot);
  blobs.restoreCounter();

  // Agent files sit beside the database, in their own tree keyed by agent id.
  const agentsRoot = path.join(dataRoot, AGENTS_DIR_NAME);
  fs.mkdirSync(agentsRoot, { recursive: true });
  const agentFiles = new FileAgentStore(agentsRoot);

  const repos: Repositories = {
    projects: new SqliteProjectRepository(db),
    agents: new SqliteAgentRepository(db),
    projectAgents: new SqliteProjectAgentRepository(db),
    sessions: new SqliteAgentSessionRepository(db),
    tasks: new SqliteTaskRepository(db),
    skills: new SqliteSkillRepository(db),
    agentKnowledge: new SqliteAgentKnowledgeRepository(db),
    projectKnowledge: new SqliteProjectKnowledgeRepository(db),
    outputs: new SqliteOutputRepository(db),
    blobs,
  };

  return {
    repos,
    uow: new SqliteUnitOfWork(db, repos, blobs),
    // Shares the connection, so a note joins whatever transaction is open.
    reviews: new SqliteReviewNoteStore(db),
    agentFiles,
    db,
    dataRoot,
    databasePath,
    schemaVersion: LATEST_SCHEMA_VERSION,
    applied,
    close(): void {
      db.close();
    },
  };
}

export { SqliteDatabase } from './database.js';
export { FileBlobStore } from './fileBlobStore.js';
export type { Migration } from './migrations.js';
export { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from './migrations.js';
export {
  SqliteAgentKnowledgeRepository,
  SqliteAgentRepository,
  SqliteAgentSessionRepository,
  SqliteOutputRepository,
  SqliteProjectAgentRepository,
  SqliteProjectKnowledgeRepository,
  SqliteProjectRepository,
  SqliteSkillRepository,
  SqliteTaskRepository,
} from './repositories.js';
export { SqliteUnitOfWork } from './unitOfWork.js';

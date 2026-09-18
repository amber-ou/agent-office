/**
 * Storage adapters for the Agent Office domain ports.
 *
 * Two adapters, both satisfying the same contract suite in
 * `storage/__tests__/repositoryContract.ts` without it being modified:
 *
 *   in-memory  tests and throwaway runs; nothing survives the process.
 *   sqlite     the canonical local store (ADR 006). Metadata in SQLite,
 *              blob content on the filesystem beside it.
 *
 * The data root is `~/.agent-office/` — deliberately separate from upstream's
 * `~/.pixel-agents/`, so neither writes into the other's files. That path is a
 * decision belonging to this layer; nothing in `domain/` knows it exists.
 */

export { clone, InMemoryRepository } from './memory/inMemoryRepository.js';
export type { InMemoryRepositories, InMemoryStorage } from './memory/repositories.js';
export {
  createInMemoryRepositories,
  createInMemoryStorage,
  InMemoryAgentKnowledgeRepository,
  InMemoryAgentRepository,
  InMemoryAgentSessionRepository,
  InMemoryBlobStore,
  InMemoryOutputRepository,
  InMemoryProjectAgentRepository,
  InMemoryProjectKnowledgeRepository,
  InMemoryProjectRepository,
  InMemorySkillRepository,
  InMemoryTaskRepository,
  InMemoryUnitOfWork,
} from './memory/repositories.js';
export type { SnapshotHandle, Snapshottable } from './memory/transaction.js';
export type { OpenSqliteStorageOptions, SqliteStorage } from './sqlite/index.js';
export {
  BLOBS_DIR_NAME,
  DATABASE_FILE_NAME,
  DEFAULT_DATA_DIR_NAME,
  defaultDataRoot,
  FileBlobStore,
  LATEST_SCHEMA_VERSION,
  migrate,
  MIGRATIONS,
  openSqliteStorage,
  SqliteAgentKnowledgeRepository,
  SqliteAgentRepository,
  SqliteAgentSessionRepository,
  SqliteDatabase,
  SqliteOutputRepository,
  SqliteProjectAgentRepository,
  SqliteProjectKnowledgeRepository,
  SqliteProjectRepository,
  SqliteSkillRepository,
  SqliteTaskRepository,
  SqliteUnitOfWork,
} from './sqlite/index.js';
export type { Migration } from './sqlite/migrations.js';

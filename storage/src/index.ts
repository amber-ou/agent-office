/**
 * Storage adapters for the Agent Office domain ports.
 *
 * Milestone 1 ships the in-memory adapter only. File, SQLite and Postgres
 * adapters land in Milestone 2 and must satisfy the same contract suite in
 * `storage/__tests__/repositoryContract.ts` without it being modified.
 *
 * The development data root is `~/.agent-office/` — deliberately separate from
 * upstream's `~/.pixel-agents/`, so neither writes into the other's files. That
 * path is a decision belonging to the file adapter; nothing in `domain/` knows
 * it exists.
 */

export { clone, InMemoryRepository } from './memory/inMemoryRepository.js';
export type { InMemoryRepositories } from './memory/repositories.js';
export {
  createInMemoryRepositories,
  InMemoryAgentRepository,
  InMemoryAgentSessionRepository,
  InMemoryBlobStore,
  InMemoryKnowledgeRepository,
  InMemoryOutputRepository,
  InMemoryProjectRepository,
  InMemorySkillRepository,
  InMemoryTaskRepository,
  InMemoryUnitOfWork,
} from './memory/repositories.js';

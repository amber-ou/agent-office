/**
 * Schema versioning.
 *
 * `PRAGMA user_version` holds the schema version of a database file. Migrations
 * are an append-only list: each one moves the file from `version - 1` to
 * `version`, and the whole run happens in one transaction so a half-applied
 * schema is not a state the file can be left in.
 *
 * A file created from nothing runs every migration in order, which is also how
 * a fresh, empty database is initialised — there is no separate "create schema"
 * path that could drift from the migration path.
 */

import type { SqliteDatabase } from './database.js';

export interface Migration {
  /** 1-based, contiguous, append-only. Never renumber or edit a shipped one. */
  version: number;
  name: string;
  up: string;
}

/**
 * Migration 1 — the Milestone 1 domain model (ADR 001, 002, 005).
 *
 * Mapping rules, applied uniformly:
 *  - Identity and foreign keys are TEXT columns holding canonical uuids.
 *  - Timestamps are TEXT holding ISO 8601 UTC, exactly as the domain carries them.
 *  - Scalars the repositories filter on get their own column.
 *  - Everything else nested (tool grants, memory, appearance, source, location,
 *    metadata, tags, dependencies, inputs, outputs) is a JSON TEXT column.
 *    Those are read and written whole; giving each a table would buy nothing and
 *    would let the row disagree with the domain object.
 *  - Ownership is expressed as NOT NULL foreign keys, so the M1 boundaries are
 *    enforced by the database and not only by the type system.
 *
 * Large content never lands here: Knowledge and Output rows hold a ResourceRef,
 * and the bytes live in the BlobStore.
 */
const MIGRATION_001: Migration = {
  version: 1,
  name: 'initial-domain-model',
  up: `
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL,
  settings    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_projects_status ON projects (status);

-- Agents are GLOBAL: no project_id column exists, by design (ADR 005).
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  description   TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT,
  tools         TEXT NOT NULL,
  memory        TEXT NOT NULL,
  appearance    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

-- Deliberately NOT unique: two agents may share a role (ADR 005).
CREATE INDEX idx_agents_role ON agents (role);

-- Project <-> Agent membership.
CREATE TABLE project_agents (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  manager_agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
  seat_id          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

-- One agent joins one project once.
CREATE UNIQUE INDEX uq_project_agents_pair ON project_agents (project_id, agent_id);
CREATE INDEX idx_project_agents_agent ON project_agents (agent_id);
CREATE INDEX idx_project_agents_manager ON project_agents (project_id, manager_agent_id);

-- A skill belongs to exactly one agent. No project column, no global library.
CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  source         TEXT NOT NULL,
  required_tools TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

-- Slugs are unique within their owning agent, not globally.
CREATE UNIQUE INDEX uq_skills_agent_slug ON skills (agent_id, slug);

CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  assigned_agent_id   TEXT REFERENCES agents (id) ON DELETE SET NULL,
  created_by_agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
  parent_task_id      TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  status              TEXT NOT NULL,
  priority            TEXT NOT NULL,
  dependencies        TEXT NOT NULL,
  inputs              TEXT NOT NULL,
  outputs             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_tasks_project ON tasks (project_id, status);
CREATE INDEX idx_tasks_assigned ON tasks (assigned_agent_id, status);
CREATE INDEX idx_tasks_parent ON tasks (parent_task_id);

-- A session names BOTH the agent and the project it runs in (ADR 005).
CREATE TABLE agent_sessions (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id             TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  last_heartbeat_at   TEXT,
  error               TEXT,
  provider_session_id TEXT,
  runtime_id          TEXT,
  transcript_path     TEXT,
  runtime_agent_id    INTEGER,
  created_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_sessions_agent ON agent_sessions (agent_id, status);
CREATE INDEX idx_sessions_project ON agent_sessions (project_id);
-- Deliberately NOT unique: a provider id may be reused across runs (ADR 002).
CREATE INDEX idx_sessions_provider ON agent_sessions (provider, provider_session_id);

-- Permanent knowledge owned by ONE agent.
CREATE TABLE agent_knowledge (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  source     TEXT NOT NULL,
  location   TEXT NOT NULL,
  tags       TEXT NOT NULL,
  metadata   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_agent_knowledge_agent ON agent_knowledge (agent_id, type);

-- Knowledge owned by ONE project. A separate table from agent_knowledge on
-- purpose: there is no row that can belong to both, and no UPDATE that moves a
-- row from one to the other.
CREATE TABLE project_knowledge (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  source     TEXT NOT NULL,
  location   TEXT NOT NULL,
  tags       TEXT NOT NULL,
  metadata   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_project_knowledge_project ON project_knowledge (project_id, type);

CREATE TABLE outputs (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  produced_by_agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  session_id          TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  type                TEXT NOT NULL,
  location            TEXT NOT NULL,
  metadata            TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_outputs_project ON outputs (project_id);
CREATE INDEX idx_outputs_task ON outputs (task_id);
`,
};

/**
 * Migration 2 — review notes (M4 Phase 2).
 *
 * The human half of the review cycle. An application-level record, not a domain
 * entity: the frozen M1 model represents continuation as another AgentSession
 * over the same provider session, so it needed no change. Cascades with its
 * task, because a note about a task that is gone is not history, it is litter.
 */
const MIGRATION_002: Migration = {
  version: 2,
  name: 'task-review-notes',
  up: `
CREATE TABLE task_review_notes (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  -- The run this note was written about, and the revision it started.
  about_session_id     TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  triggered_session_id TEXT REFERENCES agent_sessions (id) ON DELETE SET NULL,
  author               TEXT NOT NULL,
  body                 TEXT NOT NULL,
  created_at           TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_review_notes_task ON task_review_notes (task_id, created_at);
`,
};

export const MIGRATIONS: readonly Migration[] = [MIGRATION_001, MIGRATION_002];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/**
 * Bring a database up to the latest schema version.
 *
 * Returns the migrations that were applied — empty when the file was already
 * current. A file newer than this build is refused rather than downgraded: the
 * alternative is silently corrupting data written by a later version.
 */
export function migrate(db: SqliteDatabase): Migration[] {
  const current = db.userVersion;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${current} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}); upgrade Agent Office or use a different database`,
    );
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > current).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) {
    return [];
  }

  // One transaction for the whole run: a file is never left half-migrated.
  db.exec('BEGIN');
  try {
    for (const migration of pending) {
      db.exec(migration.up);
      db.setUserVersion(migration.version);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return pending;
}

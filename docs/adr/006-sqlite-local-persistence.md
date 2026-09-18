# 006 — SQLite is the canonical local store

**Status**: Accepted (Milestone 2)
**Date**: 2026-09
**Builds on**: [ADR 004](004-provider-independent-domain.md) (storage-independent domain),
[ADR 005](005-global-agents-and-knowledge-ownership.md) (ownership boundaries)

## Context

Milestone 1 shipped ports and an in-memory adapter, so nothing survived a
restart. Milestone 2 makes local data durable, with SQLite as the canonical
local database for V1.

The driver has to work in every target this repository already claims:

- the standalone CLI, whose `engines.node` is `>= 20`, with a CI job that smoke-tests
  the npm package on Node 20;
- the VS Code extension, which runs on Electron's own Node ABI;
- Linux, macOS and Windows, across the three-OS CI matrix.

## Decision

### Driver: `node-sqlite3-wasm`

SQLite compiled to WebAssembly, with real file I/O.

It is the only one of the three candidates that clears all the targets without
new build or packaging machinery:

| Candidate               | Why not                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:sqlite`           | Node 22.5+ only, and still flagged experimental. `engines.node >= 20` and the Node 20 CI job rule it out.                                                                                          |
| `better-sqlite3`        | Native. Needs a prebuilt binary per platform _and_ per ABI, and an `electron-rebuild` step for the VS Code extension. Real, well-trodden, and more packaging burden than this milestone justifies. |
| **`node-sqlite3-wasm`** | **One WASM file, no native build, no ABI coupling to Electron, same behaviour on all three OSes. Synchronous API, which suits the repository-per-call shape.**                                     |

The cost is throughput: WASM SQLite is slower than the native build. This
workload is project/agent/task metadata — hundreds to thousands of small rows —
so the trade is comfortable, and `SqliteDatabase` wraps the driver in one file
so swapping it later is a contained change.

### Metadata in SQLite, content on the filesystem

Rows hold a `ResourceRef`; blob bytes live under `<dataRoot>/blobs/`, namespaced
by owner kind (`project/<id>/…`, `agent/<id>/…`). Keeping potentially large
content out of the database keeps it small enough to copy, back up and open
quickly, and makes a large upload a file write rather than a row rewrite.

`<dataRoot>` is `~/.agent-office/`, holding `agent-office.db` and `blobs/`.

### One domain model, mapped

`storage/src/sqlite/mapping.ts` translates domain objects to and from rows.
There is no persistence-shaped second model. Scalars the repositories filter on
get their own column; everything else nested travels as JSON text, read and
written whole so a row cannot disagree with the object it came from. SQL `NULL`
reads back as `undefined`, which is what the domain uses for an absent optional.

### The M1 ownership boundaries become database constraints

What the type system enforced at compile time, the schema now also enforces at
run time:

- `agents` has no `project_id` column at all — agents are global.
- `skills.agent_id` is `NOT NULL REFERENCES agents(id)`, with
  `UNIQUE (agent_id, slug)`. There is no project column and no global library.
- `agent_knowledge` and `project_knowledge` are **two tables**. Neither has a
  column that could hold the other's owner, so no `UPDATE` can move a row from
  one to the other.
- `project_agents` has `UNIQUE (project_id, agent_id)`.
- `agent_sessions` references both `agent_id` and `project_id`.
- `tasks.project_id` is `NOT NULL`.
- `PRAGMA foreign_keys = ON` is set on every open, because it is per-connection
  and off by default — without it the `REFERENCES` clauses are decoration.

Cascades follow ownership: deleting a project removes its tasks, memberships,
sessions, project knowledge and outputs, and touches no agent, no skill and no
agent knowledge.

### Migrations

`PRAGMA user_version` holds the schema version. Migrations are an append-only
list, each moving a file from `version - 1` to `version`, and the whole run
happens in one transaction so a file is never left half-migrated. A fresh
database runs every migration in order — there is no separate "create schema"
path that could drift from the migration path. A file newer than the running
build is refused rather than downgraded.

### `put` is a true upsert, never `INSERT OR REPLACE`

`INSERT OR REPLACE` looks like the obvious way to implement an upsert and is a
trap, in two distinct ways. Both were caught by the M1 contract suite running
against this adapter:

1. It **DELETEs** the conflicting row before inserting, and that delete fires
   `ON DELETE CASCADE`. Re-saving a project would silently destroy its tasks,
   memberships and knowledge.
2. It resolves **any** UNIQUE conflict by replacing the other row. A second
   membership for the same `(project_id, agent_id)` pair would quietly overwrite
   the first instead of being refused, making every unique index in the schema
   inert.

`INSERT … ON CONFLICT(id) DO UPDATE SET …` touches only the row with that id,
leaves children alone, and lets every other constraint raise as it should.

### Transactions

`SqliteUnitOfWork` satisfies the same port as the in-memory one, by a different
mechanism: `BEGIN` / `COMMIT` / `ROLLBACK` on the shared connection instead of
snapshot-and-restore. The two structural rules are identical — top-level
transactions are serialised, and a nested `run()` joins the outer transaction
rather than opening its own — and nesting is detected with `AsyncLocalStorage`
so a concurrent caller queues instead of being swept in.

Blob content is not in SQLite, so it gets a **compensating journal**: writes are
recorded so a rollback can remove them, and deletes are deferred to commit so a
rollback has nothing to undo. Within an open transaction a deleted blob already
reads as missing, so the caller sees the same state SQLite shows it.

That is compensation, not atomicity: a crash between `COMMIT` and the deferred
unlink leaves an orphan file. An orphan is unreferenced and harmless, whereas
the opposite failure — a row pointing at content that was rolled away — is not,
so the ordering is deliberate.

### An empty database stays empty

Initialisation creates the schema and inserts nothing. No agents, no skills, no
knowledge, no projects, no prompts.

## Consequences

**Gained**

- Data survives restarts; the ownership rules are enforced by the database as
  well as the type system.
- Both adapters pass the same contract suite, unmodified, so the in-memory one
  remains a faithful stand-in for tests and throwaway runs.
- No native build, no `electron-rebuild`, no per-platform prebuilds.

**Given up**

- WASM SQLite is slower than the native build.
- One connection and a serialising mutex: writes do not run in parallel. For a
  local single-operator store that is the simpler correct choice.
- Tag filtering happens in TypeScript rather than SQL, because tags are a JSON
  array. Worth revisiting if a project ever holds enough knowledge for it to
  matter.
- Blob rollback is compensating, with the orphan-file window described above.

**Pinned by**

- `storage/__tests__/sqlite.test.ts` — the M1 contract suite run against SQLite,
  plus close/reopen durability, empty-database initialisation, migration
  behaviour, foreign-key enforcement, membership and slug uniqueness, the two
  knowledge tables, and transaction commit/rollback across a reopen.

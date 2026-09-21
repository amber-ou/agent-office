# ADR 0007 — Agent-owned configuration lives in files

Status: accepted (M5 Phase 1)

## Context

An Agent's permanent configuration — its instructions, its Skills, its
foundational Knowledge — was held in the Office database: rows in SQLite and
blobs beside it. That made the Office the owner of something that is not the
Office's: an Agent is meant to be independent of the workspace that runs it,
and the confirmed memory architecture puts its long-term memory behind an MCP
provider later, with these files as the foundation.

## Decision

Each Agent owns a directory keyed by its immutable id:

```
~/.agent-office/agents/<agent-id>/
  agent.json                    identity marker only: { id, schema, createdAt, migratedAt }
  instructions.md               the agent's instructions (its systemPrompt)
  skills/<skill-id>/SKILL.md    front matter + body
  knowledge/<knowledge-id>.md   front matter + body
```

- **Ids, never names.** Every path segment is a canonical uuid. A name, a slug
  or a title never reaches the filesystem, so renaming an Agent moves nothing
  and a hostile string has nowhere to go.
- **One source of truth.** Once an Agent is migrated, the files are
  authoritative for instructions, skills and knowledge. SQLite keeps the
  registry entry (name, role, provider, model) and the operational state
  around it. The legacy rows and blobs stay where they are, unread.
- **Front matter is JSON.** `name: "Run a user interview"`. A title may contain
  a colon, a quote or a newline, and a format that is ambiguous about those is
  a format that loses someone's content.

## Migration

`migrateAgentFiles` runs when the database opens. It is idempotent,
restart-safe and non-destructive. For an Agent that has **not yet moved**:

- a file that does not exist is written from the row;
- a file that exists and matches is left alone;
- a file that exists and **differs** is a conflict: neither copy is touched,
  the conflict is reported, and that Agent keeps reading the database and
  refuses configuration edits until a person resolves it;
- knowledge whose stored content cannot be read is refused rather than
  migrated as an empty file;
- the Agent switches over only after every one of its resources has been
  written and read back.

**Completion is recorded in the database** (`agent_file_migrations`), not only
in the Agent's own `agent.json`. That is the difference between "has not moved
yet" and "moved, and its files are gone", and getting it wrong loses data in
both directions: an already-migrated Agent must never be rewritten from the
legacy rows, or deleting a migrated Skill would resurrect it on the next
start.

Once an Agent is file-backed, the migration never writes its content again.
Editing, adding and deleting are ordinary file operations, and none of them is
a conflict.

## Recovery: what the legacy data can and cannot restore

**The legacy rows are not a backup.** They are a frozen copy of what each
Agent looked like _at the moment it migrated_. Everything since — a new Skill,
an edited instruction, a deleted Knowledge item — exists only in the files.

So:

- **Deleting an Agent's directory is not a recovery route.** It destroys
  everything written since the migration. It is never the suggested fix.
- The legacy rows can restore only what they still hold: the pre-migration
  state of Agents that had already been migrated, and the full state of Agents
  that never moved.
- A file-backed Agent whose files are missing or unreadable is reported as
  **damaged**: nothing is rebuilt from the database, the office says so
  (`configIssue` on `agentDetail`), configuration edits are refused, and
  running its tasks fails loudly rather than running with whatever the rows
  happen to say. The repair is restoring from a backup — see
  [backup and restore](../backup-and-restore.md).

Nothing in this phase deletes legacy rows or blobs; they stay as the only
recovery path for a pre-migration state.

## Isolation: three different layers, with different strengths

These are not interchangeable, and describing them as one thing overstates
what is actually enforced.

**1. Office API ownership checks — enforced.** Every agent-scoped call takes
the owning `agentId`, and the path is built from that id alone. A borrowed
skill or knowledge id finds nothing rather than another Agent's file, a
mutation without an `agentId` is refused, and every path segment must be a
canonical uuid, so `..`, an absolute path and a stray slash are all rejected
before any filesystem call.

**2. Claude file-tool deny rules — enforced by Claude Code, for its file
tools only.** Each run passes `--settings` with deny rules for the agents root
(`Read`, `Write`, `Edit`, `NotebookEdit`, using Claude's `//abs/path/**`
syntax). This was verified against the real CLI: both a read and an edit of a
denied path were refused and the file was unchanged.

**3. Bash and any child process — NOT covered.** A shell command started by a
run executes with this process's own OS permissions and can reach any path the
office can, including `agents/`. The deny rules above do not apply to it.

So layers 1 and 2 are real enforcement within their scope; layer 3 is an open
gap. **These deny rules are not a runtime sandbox**, and this ADR does not
record the gap as an accepted permanent state — closing it means OS-level
isolation of the runtime process (a container, a separate user, or a platform
sandbox), which is a deployment decision that has not been taken.

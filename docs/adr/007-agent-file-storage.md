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
restart-safe and non-destructive:

- a file that does not exist is written from the row;
- a file that exists and matches is left alone;
- a file that exists and **differs** is a conflict: neither copy is touched,
  the conflict is reported, and that Agent keeps reading the database and
  refuses configuration edits until a person resolves it;
- an Agent switches over only after every one of its resources has been
  written and read back.

**Recovery** is deleting the Agent's directory (or the whole `agents/` tree):
the legacy rows and blobs were never modified, so the next open rebuilds the
files from them. Nothing in this phase deletes legacy data.

## Isolation, and its limit

Through the Office API, isolation is structural: every agent-scoped call takes
the owning `agentId`, and the path is built from it — a borrowed skill or
knowledge id finds nothing rather than someone else's file.

For Claude Code runs, the bridge passes `--settings` deny rules for the agents
root. Claude Code enforces those for its own file tools (`Read`, `Write`,
`Edit`, `NotebookEdit`) — verified against the real CLI.

**It does not cover `Bash`.** A shell command runs as the same user and can
reach any path this process can. Denying `Bash` outright would stop agents
doing real work, so the current posture is: file tools are blocked and
enforced, `Bash` is a known hole. Closing it needs OS-level sandboxing of the
runtime process, which is out of scope for this phase.

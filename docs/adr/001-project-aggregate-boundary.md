# 001 — Project aggregate boundary

**Status**: Accepted (Milestone 1)
**Amended by**: [ADR 005](005-global-agents-and-knowledge-ownership.md) — agents are global, so they are not project contents at all; membership is `ProjectAgent`.
**Date**: 2026-09

## Context

The original requirement described a Project as containing its contents directly:

```
Project
- id, name, description, status, createdAt, updatedAt
- agents[]
- tasks[]
- knowledge[]
- outputs[]
- settings
```

Read literally, that makes `Project` the aggregate root for everything in it:
one stored document holding every agent, every task, every knowledge item and
every output.

Agent Office is meant to be used for a long time, across many projects, with a
Manager Agent decomposing goals into many tasks. A mature project is not five
tasks; it is hundreds, plus their outputs. The storage layer must also be able
to move from JSON files to SQLite to PostgreSQL without the domain changing
(ADR 004).

Three concrete problems with the embedded shape:

1. **Write amplification.** Moving one task from `todo` to `in_progress` rewrites
   the entire project document, including every unrelated task and output.
2. **Concurrency.** Two agents finishing two different tasks at the same time
   both rewrite the whole document; last writer wins and the other update is
   lost. With separate rows, they do not touch each other.
3. **No pagination.** A UI that wants "the 20 most recent tasks" has to load
   everything first. In SQL this shape is a single JSON column, which gives up
   indexing and querying entirely.

## Decision

`Project` holds only its own fields. Contents reference it by foreign key:

```ts
Project          { id, name, description, status, settings, createdAt, updatedAt }
ProjectAgent     { projectId, agentId, … }   // membership (ADR 005)
Task             { projectId, … }
ProjectKnowledge { projectId, … }            // agent knowledge is NOT project content
OutputItem       { projectId, … }
AgentSession     { projectId, … }
```

`AgentDefinition` is absent from that list on purpose: ADR 005 makes agents
global, so a project does not contain them — it has memberships pointing at
them.

Each has its own repository with a `listByProject(projectId, filter?)` method.

For the cases that genuinely want the whole picture, `ProjectAggregate` is a
**read model**:

```ts
interface ProjectAggregate {
  project: Project;
  agents: readonly AgentDefinition[];
  sessions: readonly AgentSession[];
  tasks: readonly Task[];
  knowledge: readonly KnowledgeItem[];
  outputs: readonly OutputItem[];
}
```

It is composed by a query service from several repositories. It is never
persisted, never the unit of a write, and never what a repository returns from
`put`. It lives in `domain/src/projectAggregate.ts` rather than `project.ts`, so
the Project module does not have to import every other entity just to describe a
view of them.

Writes that legitimately span several repositories go through `UnitOfWork`, which
an in-memory or file adapter may implement as a plain call and a SQL adapter as a
transaction.

This is a deliberate, accepted deviation from the literal wording of the original
requirement.

## Consequences

**Gained**

- Updating a task touches one record.
- Two agents can work concurrently without clobbering each other.
- `listByProject` can paginate and filter; SQL indexes become possible.
- Each entity migrates to a table of its own with no domain change.
- Project isolation is enforced in one obvious place — the foreign key — and is
  directly testable (`storage/__tests__/repositoryContract.ts` pins it).

**Given up**

- "Load the project" is several calls, not one. A query service assembles
  `ProjectAggregate`.
- Referential integrity is the service layer's job until a database enforces it:
  nothing stops an `AgentDefinition` pointing at a deleted `ProjectId`.
- Cascade delete must be written explicitly rather than falling out of deleting
  one document.

**Pinned by**

- `domain/__tests__/project.test.ts` — "does NOT embed agents, tasks, knowledge
  or outputs"
- `storage/__tests__/repositoryContract.ts` — the project isolation suite

# 002 — AgentDefinition, AgentSession and Task are three separate things

**Status**: Accepted (Milestone 1)
**Date**: 2026-09

## Context

Upstream Pixel Agents defines an Agent as "an AI coding session tracked by Pixel
Agents". Agent _is_ session. When the session ends, the agent is removed from the
office; when the transcript file is deleted, the agent is gone. `AgentState`
carries `sessionId`, `jsonlFile`, `fileOffset`, `terminalRef`, `activeToolIds`,
`hookDelivered` — all of it process-local runtime state, all of it on the same
object as the agent's name and colour.

Agent Office needs the opposite: an agent is an employee. The UX Agent exists on
Monday, runs four times on Tuesday, crashes once on Wednesday, and is still the
UX Agent on Thursday. Nothing about a run may be able to delete it.

There is also a third thing that is easy to fold into the second: the work. A run
exists in order to do something, but "what the agent is" and "what it is doing
this minute" and "what it has been asked to achieve" answer different questions
and have different lifetimes.

Upstream's numeric agent id makes the confusion concrete. It is a per-adapter
counter (`store.nextAgentId`), resumed from the persisted maximum after a
restart. It is not stable, not globally unique, and not meaningful across
machines — but it is the only handle the office has on a character.

## Decision

Three types, three lifetimes, one direction of dependency.

| Type              | Answers                               | Lifetime                 |
| ----------------- | ------------------------------------- | ------------------------ |
| `AgentDefinition` | who this agent is                     | until a human deletes it |
| `AgentSession`    | one runtime instance of this agent    | one run                  |
| `Task`            | what this agent was asked to complete | until done or abandoned  |

`AgentSession.agentId` points at the definition. `AgentSession.taskId` points at
the work. Ending or deleting a session never touches either.

### Provider-specific runtime state may live only on AgentSession

Claude session UUIDs, Codex runtime ids, terminal ids, process ids, transcript
paths, hook state, upstream's numeric agent id: all of them are `AgentSession`
fields, all optional, all documented as integration metadata.

This is enforced at compile time, not by review. `domain/__tests__/agentDefinition.test.ts`
declares the forbidden field names and asserts that

```ts
type LeakedFields = Extract<keyof AgentDefinition, ForbiddenOnDefinition>;
type DefinitionIsClean = [LeakedFields] extends [never] ? true : false;
```

still resolves to `true`. Adding `providerSessionId` or `status` to
`AgentDefinition` fails the build.

### Canonical identity is Agent Office's own UUID

Every entity is keyed by a uuid this system generated. Nothing else is ever a
primary key: not an array index, not upstream's numeric agent id, not a Claude
session id. `asAgentId()` and its siblings are the only way into the branded id
types, and they reject anything that is not uuid-shaped.

### `providerSessionId` is a reconciliation key, not an identity

It is accepted as the way to match an Agent Office session against what upstream
observed, but the domain assumes neither of the following:

- **that it exists** — it is optional, and a session with none is valid;
- **that it is unique** — a provider may reuse one across runs, and two providers
  may mint the same value.

The port reflects that. There is no `findByProviderSessionId` returning one
session. There is:

```ts
listByProviderSessionId(provider: string, providerSessionId: string): Promise<AgentSession[]>
```

scoped by provider and returning a list. The caller decides which match it meant.

### Status is derived, not stored

`AgentDefinition` has no `status` field. What the office displays is computed by
`resolveAgentStatus(session, task, observed)` — see ADR 003 and
`domain/src/agentStatus.ts` for the precedence table. A stored status would be a
fourth thing that can disagree with the other three.

## Consequences

**Gained**

- An agent survives its runs, restarts, crashes and container loss.
- Adding a provider adds fields to `AgentSession` only; `AgentDefinition` is
  provider-shaped for nobody.
- Run history is queryable: `listByAgent(agentId)` returns every session an agent
  has ever had, because none of them were deleted to make room for the next.
- Upstream's numeric id is quarantined in one optional field, so its instability
  cannot propagate.

**Given up**

- Reconciling an Agent Office session with an upstream character is a lookup, not
  a direct reference — and a lookup that may return zero or several rows.
- Three records where upstream had one. Creating an agent and running it are two
  operations.
- The service layer must decide what to do when `listByProviderSessionId` returns
  more than one session. Milestone 6 owns that rule; the domain refuses to guess
  it here.

**Pinned by**

- `domain/__tests__/agentDefinition.test.ts` — the compile-time and runtime leak checks
- `domain/__tests__/agentSession.test.ts` — "keeps the AgentDefinition alive across
  the whole session lifecycle"
- `domain/__tests__/identity.test.ts` — canonical identity for every entity
- `storage/__tests__/repositoryContract.ts` — the provider-session-id list contract

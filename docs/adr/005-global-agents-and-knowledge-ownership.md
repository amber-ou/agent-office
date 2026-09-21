# 005 — Agents are global; knowledge ownership is strict

**Status**: Accepted (Milestone 1, correcting the model shipped in `c498323`)
**Date**: 2026-09
**Amends**: ADR 001, ADR 002

## Context

Milestone 1 shipped agents owned by projects: `AgentDefinition.projectId`, a
project-scoped `role`, a Skill scoped to a project or global, and one
`KnowledgeItem` type with a `projectId`.

The confirmed product model is different in three ways, and each of them makes
that shape wrong rather than merely inconvenient.

**Agents are the reusable thing; projects are the disposable thing.** An agent
is an independent specialist owned by Agent Office. The same agent works on
several projects at once. Under project ownership, "use my UX agent on the new
project" means copying it, and from that moment there are two agents whose
instructions drift apart.

**Skills belong to agents, not to a library.** A shared Skill library makes a
skill a thing several agents depend on, so editing it changes every agent that
references it — the opposite of independent specialists. Skills do not need to
be reusable across agents.

**Knowledge has two owners with different lifetimes, and they must not mix.**
An agent's specialist knowledge is permanent and travels with it. A project's
knowledge is temporary and belongs to that work context. The dangerous direction
is project → agent: if anything a project produces can end up as permanent agent
memory, then working on one project silently changes how the agent behaves on
every other one. A single `KnowledgeItem` with an owner field makes that a
one-line mistake.

Separately: Agent Office ships **empty**. No default agents, no default skills,
no default knowledge, no default prompts, no seed data. Operators create their
own.

## Decision

### 1. AgentDefinition is global

`projectId` is removed. An agent belongs to Agent Office.

`role` stays as a descriptive stable key but is no longer unique — the registry
is global, and two differently-configured agents may both be "ux". The port
reflects that: `listByRole(role)` returns a list, not `findByRole` returning one.

Two fields moved off the definition because they are per-project facts, not
per-agent ones:

| Field               | Moved to       | Why                                                         |
| ------------------- | -------------- | ----------------------------------------------------------- |
| `managerAgentId`    | `ProjectAgent` | The same agent may lead one project and report in another.  |
| `appearance.seatId` | `ProjectAgent` | An agent sits at a different desk in each project's office. |

`palette` and `hueShift` stay on the agent: its look travels with it.

### 2. ProjectAgent is the membership

```ts
interface ProjectAgent {
  id: ProjectAgentId;
  projectId: ProjectId;
  agentId: AgentId;
  managerAgentId?: AgentId; // within this project
  seatId?: string | null; // in this project's office
  createdAt;
  updatedAt;
}
```

Minimal by intent. Uniqueness is `(projectId, agentId)`. Deleting a membership
removes the agent from that project and touches nothing else — not the
definition, not its skills, not its knowledge, not its other memberships.

`assertManagerIsMember` refuses a manager who is not a member of the same
project; `assertNotAlreadyMember` refuses a duplicate pair. Both are pure and
take the memberships as an argument.

### 3. Skills are owned by one agent

Ownership points from the skill to the agent (`Skill.agentId`), and
`AgentDefinition` carries **no** skill list. A denormalised `skillIds[]` would be
a second source of truth that can disagree with the first.

`Skill.projectId` is gone; so are `listGlobal`, `listAvailable` and
`isSkillAvailableTo`. The repository offers `listByAgent(agentId)` and
`findBySlug(agentId, slug)`. Slugs are unique within an owning agent, so two
agents may each own a `user-research` skill and they are unrelated records.

`agentId` is absent from `SkillPatch`: moving a skill to another agent is not an
edit.

### 4. Knowledge is two types, not one with an owner

```ts
interface AgentKnowledge   { id: AgentKnowledgeId;   agentId: AgentId;     … }
interface ProjectKnowledge { id: ProjectKnowledgeId; projectId: ProjectId; … }
```

Separate types, **separate id brands**, separate repositories. The rule this
enforces is absolute, so it is enforced by the compiler rather than by review:

- there is no function in the domain that takes a `ProjectKnowledge` and returns
  an `AgentKnowledge` — no `promote`, no `copyInto`, no `absorb`;
- `ProjectKnowledgeId` cannot be passed where an `AgentKnowledgeId` is expected;
- the owner is absent from `KnowledgePatch`, so neither kind can be re-homed by
  an update;
- there is no `createKnowledgeItem` that could be aimed at either owner.

`source: { origin: 'agent', agentId }` remains available on **project**
knowledge. That is provenance — "the UX agent wrote this during the project" —
and it is explicitly not ownership. The knowledge stays the project's.

`BlobStore.write` now takes a `BlobOwner` (`project` or `agent`) instead of a
bare `projectId`, so the boundary holds for content as well as metadata.

### 5. Runtime context composes; it never persists back

`AgentContextBundle` carries `agentKnowledge` and `projectKnowledge` as two
separate fields of two separate types, alongside the agent's instructions, its
skills and the current task. It is assembled, handed to a runtime, and
discarded. `KnowledgeSelector` has two methods for the same reason — one
`select()` over a merged list would require the two kinds to share a type.

### 6. The five concepts stay distinct

| Concept           | Is                                                                 |
| ----------------- | ------------------------------------------------------------------ |
| `AgentDefinition` | reusable independent specialist, owned by Agent Office             |
| `Project`         | isolated work context                                              |
| `ProjectAgent`    | membership between the two                                         |
| `Task`            | project-owned work unit                                            |
| `AgentSession`    | one runtime execution, carrying **both** `agentId` and `projectId` |

`AgentSession` already carried both; that is now load-bearing rather than
incidental, because `agentId` alone no longer implies a project.

### 7. No seed data

The domain and storage packages ship no content of any kind. Agent Office starts
empty and is filled by its operator.

## Consequences

**Gained**

- One agent, many projects, one set of instructions. No copy-and-drift.
- An agent's specialist configuration cannot be changed by project activity.
- Per-project hierarchy and seating are expressible without duplicating agents.
- The project→agent knowledge leak is a compile error, not a code-review topic.

**Given up**

- "The agents on this project" is now a join: read memberships, then read the
  definitions. The in-memory adapter does this in two calls; a SQL adapter will
  do it in one query.
- Referential integrity across the membership table is the service layer's job
  until a database enforces it — nothing stops a `ProjectAgent` pointing at a
  deleted agent.
- Duplicated shape between `AgentKnowledge` and `ProjectKnowledge`. That
  duplication is the mechanism, not an oversight: merging them to remove it is
  exactly what this ADR forbids.
- `role` no longer identifies an agent, so any UI that assumed one agent per role
  per project must handle several.

**Pinned by**

- `domain/__tests__/agentDefinition.test.ts` — compile-time guard now covers
  project-scoped fields as well as runtime state
- `domain/__tests__/projectAgent.test.ts` — many-to-many, per-project hierarchy,
  membership uniqueness
- `domain/__tests__/skill.test.ts` — agent ownership, no sharing, no re-homing
- `domain/__tests__/knowledgeBoundary.test.ts` — the two owners, the absence of
  any promotion path, and that project work leaves agent memory untouched
- `storage/__tests__/repositoryContract.ts` — membership scoping, agent knowledge
  and project knowledge never appearing in each other's listings, blob owner
  namespacing

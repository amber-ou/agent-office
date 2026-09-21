# 003 — Control Plane and Agent Runtime are separated

**Status**: Accepted (Milestone 1 — boundary defined; implementation in Milestones 3 and 6)
**Date**: 2026-09

## Context

Upstream Pixel Agents is one process on one machine. The server, the office UI,
the transcript scanners, the hook installer and the agent it launches all assume
the same filesystem and the same home directory. `~/.pixel-agents/servers/*.json`
is the service discovery mechanism, and liveness is `process.kill(pid, 0)`.

Agent Office is meant to end up as:

```
GitHub → cloud deployment → Agent Office → Projects → Persistent Agents
```

That is only possible if the thing that owns the data and the thing that runs a
coding agent can be on different machines. The audit found three properties of
upstream that stand in the way, and they are properties, not bugs:

- Hooks are installed by writing `~/.claude/settings.json` on the machine where
  Claude runs.
- Heuristic detection reads `~/.claude/projects/**/*.jsonl` on that same machine.
- Service discovery is a local file plus a local pid check.

Separately, upstream's event channel is one-directional by design: ten
`AgentEvent` variants, all observational, all past-tense. There is no way to tell
an agent to do something. Task dispatch has to come from somewhere.

## Decision

Two planes, two channels.

```
CONTROL PLANE                              AGENT RUNTIME
owns Projects, Agents, Tasks,              executes Claude Code / Codex /
Knowledge, Outputs, Office state           custom MCP agents
         │                                          │
         │  ── downward: Runtime Bridge ──────────► │   NEW
         │     register, heartbeat, dispatch_task,  │
         │     report_status, report_progress,      │
         │     submit_output                        │
         │                                          │
         │ ◄── upward: AgentEvent ───────────────── │   UNCHANGED
         │     POST /api/hooks/:providerId          │
         │     observation only, one-way            │
```

### The upward channel is not modified

`AgentEvent`, `HookProvider`, `normalizeHookEvent` and the hook ingress endpoint
keep their current semantics exactly. Task dispatch is **not** added to
`AgentEvent`. That union is a well-drawn boundary — "the canonical, CLI-agnostic
description of something happening in a session" — and putting commands into it
would make it two things.

A useful side effect: because a dispatched run is a real provider session, it
produces hook events like any other, so the character animation, context gauge
and permission bubbles work with no changes at all.

### The downward channel is new and separate

`runtime/src/adapter.ts` defines `AgentRuntimeAdapter` in domain terms: an
`AgentContextBundle` in, a provider session id out. A runtime that spawns a CLI
locally and one that runs on another host are the same shape to the caller.

Milestone 1 ships the interface and the six verb names only. No process spawning,
no WebSocket, no MCP server, no Claude runtime.

### Transport, when it arrives (Milestone 6)

Local runtimes are an in-process call. Remote runtimes connect **outward** over
WebSocket and register. The direction matters: a runtime is typically a laptop or
a VPS behind NAT, so requiring inbound reachability would rule out the common
case, while `dispatch_task` requires the Control Plane to push. A runtime dialling
out satisfies both.

### Agent status is derived across the boundary

Because the two planes know different things, no single one of them can state an
agent's status:

| Status                          | Known by                      |
| ------------------------------- | ----------------------------- |
| `working`, `waiting`            | Agent Runtime (observation)   |
| `reviewing`, `blocked`, `error` | Control Plane (task state)    |
| `idle`, `offline`               | Control Plane (session state) |

So status is a pure function of both, with a fixed precedence — task state
outranks runtime state — defined in `domain/src/agentStatus.ts`. Three of the
seven statuses are literally underivable from hook events, which is why the Task
domain is a prerequisite for the office UI and not an optional extra.

### Clocks are not shared

Two machines do not share a clock. Every timestamp is an ISO 8601 UTC string, and
`lastHeartbeatAt` is stamped by the Control Plane on receipt — a runtime's
self-reported time is never trusted for ordering.

## Consequences

**Gained**

- The Control Plane can be deployed without the machines that run agents.
- A second provider is a second `AgentRuntimeAdapter`, not a fork of the runtime.
- The upstream observation pipeline keeps working untouched, so upstream merges
  stay cheap.
- Status can never be a mutable field two planes both write.

**Given up**

- Two channels to reason about instead of one.
- A dispatched run's progress arrives on both channels, so the Control Plane must
  tolerate the observation arriving before, after, or without the report.
- Heartbeat timeouts become a real failure mode with real handling.

**Constraints this creates for later milestones**

1. `installHooks(serverUrl, token)` currently hard-codes `http://127.0.0.1:<port>`.
   A remote runtime needs a reachable URL. — Milestone 6
2. Heuristic detection cannot work for a remote runtime. Hooks become the only
   detection path there, so hook delivery needs retry and idempotency. — Milestone 6
3. `~/.pixel-agents/servers/*.json` discovery does not cross machines; remote
   runtimes need explicit configuration. That is what `register` is for. — Milestone 6
4. `/ws` currently broadcasts every agent to every connection. Project scoping
   must be enforced **server-side**, not by filtering in the browser. — Milestone 4
5. The current privilege model is one bearer token in a URL query. It is adequate
   for localhost and inadequate for the public internet. — before any Milestone 9
   deployment
6. Nothing is durable today, so **Milestone 2 (Persistence) must precede
   Milestone 9 (Cloud)**. That ordering is not negotiable.

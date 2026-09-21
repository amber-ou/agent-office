# 004 — The domain depends on no provider, no storage and no UI

**Status**: Accepted (Milestone 1)
**Date**: 2026-09

## Context

Two failure modes are easy to walk into and expensive to walk out of.

**Provider capture.** Claude Code is the only provider that works today, so it is
tempting to model against it: a `sessionId` that means a Claude session UUID, a
`transcriptPath` on the agent, a `model` field typed as a union of Claude model
ids. Each is convenient once and wrong the first time a Codex or Gemini runtime
appears. Upstream avoided this deliberately — `HookProvider` keeps every
Claude-specific fact behind `normalizeHookEvent` — and that discipline is worth
inheriting rather than discarding one layer up.

**Storage capture.** The same applies downward. A domain that imports `node:fs`
cannot run in the browser; a domain that knows about `~/.agent-office/` cannot
move to PostgreSQL without touching every file; a domain with an `s3` variant in
its resource type has picked a vendor.

There is a third, less obvious constraint. The office UI will need to display
`AgentStatus` and `TaskStatus`, so `webview-ui/` must be able to import the
domain. That build enforces `erasableSyntaxOnly`, which forbids TypeScript
`enum`.

## Decision

`domain/` depends on nothing.

### No provider knowledge

- `AgentDefinition.provider` and `AgentSession.provider` are `string` — the same
  id space as upstream's `HookProvider.id`. There is no union of known providers.
- `model` is an optional `string`. The domain does not know which models exist.
- `ToolGrant.name` is a plain string, so `'Read'` and `'mcp__figma__get_file'` are
  equally expressible.
- Provider-specific identifiers appear only on `AgentSession`, and only as
  optional integration metadata (ADR 002).
- `ObservedRuntimeState` has four booleans. It describes what _any_ observation
  plane can report, not what Claude's hooks happen to send.

### No storage knowledge

- `domain/src/repositories.ts` declares interfaces and no implementations.
- `ResourceRef` is `inline | file | url | blob`. There is no `s3`, no `supabase`,
  no `sqlite`. A blob store maps `{ store: 'blob', key }` onto whatever it is.
- Metadata and content are separate: `KnowledgeItem` and `OutputItem` hold a
  reference, `BlobStore` holds the bytes.
- Every port method returns a `Promise`, including on the in-memory adapter where
  it need not. Committing to synchronous access in the port would mean rewriting
  every call site on the day it becomes SQL.
- `~/.agent-office/` appears nowhere in `domain/`. It is a decision belonging to
  the file adapter, documented in `storage/src/index.ts`.

### No host or UI knowledge

- No `node:` import anywhere in `domain/`.
- Identity and time are ports: `IdGenerator` and `Clock`. The default id
  generator probes for `globalThis.crypto.randomUUID` and falls back when the
  host does not expose it (a browser on plain http does not), rather than
  assuming a runtime.
- Tests inject a deterministic `IdGenerator` and `Clock`; no domain test needs a
  fake filesystem or a frozen system clock.
- Every union is an `as const` object, never an `enum`, so `webview-ui` can
  import the domain under `erasableSyntaxOnly`.

### Layering

```
domain/     → nothing
storage/    → domain/
runtime/    → domain/ + core/
core/       → nothing            (upstream's rule, unchanged)
server/     → core/ + domain/ + storage/ + runtime/
webview-ui/ → core/ + domain/  (types only)
adapters/   → core/ + server/
```

## Consequences

**Gained**

- Adding a provider touches `runtime/` and `server/src/control/`, never `domain/`.
- Swapping storage is a new package under `storage/` that satisfies the existing
  contract suite — which is written once, in `storage/__tests__/repositoryContract.ts`,
  and is not adapter-specific.
- The domain is testable with no I/O at all: 88 tests, no filesystem, no clock
  freezing, sub-second.
- The same types describe an entity in the server, in a runtime adapter and in
  the browser.

**Given up**

- More indirection. Reading a knowledge item is `repo.get` then `blobs.read`,
  not one call.
- Ports must be designed before there are two implementations to generalise from,
  so some of them will be wrong. The contract suite is where that gets found.
- `provider: string` gives up compile-time checking of provider ids. A registry
  validates them at the edge instead — the same trade upstream already makes with
  `HookProvider.id`.

**The test that this is real**

If a future storage adapter requires `storage/__tests__/repositoryContract.ts` to
be edited in order to pass, the port has leaked an implementation detail and the
port is what should change.

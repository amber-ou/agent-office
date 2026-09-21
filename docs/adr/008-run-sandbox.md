# ADR 0008 — Claude Code runs inside an OS sandbox

Status: accepted (M5 Phase 1.1 follow-up). Target host: **WSL2 on Windows**.

## Context

ADR 007 closed the Office API and Claude's own file tools, and recorded what
was still open: a `Bash` command started by a run executes with the Office
process's permissions and can read or write `~/.agent-office/agents/`. A deny
rule, a working directory and a prompt are not access control.

Two further holes were found while designing this, both worse than the one it
set out to close:

- **The Office control plane was unauthenticated.** Office messages bypassed
  the `privileged` check, and `/ws` accepts a connection with no `Origin`
  header. Anything that could open a loopback socket — a sandboxed run, or
  under WSL anything on the Windows side, since WSL2 shares localhost — could
  read every Agent's instructions, skills and knowledge, and write them.
- **A resumed run inherited the previous Agent's conversation.** A revision
  picked the newest session for the Task regardless of who ran it, so a
  reassigned Task handed the new Agent the old one's transcript.

## Decision

**1. Every run executes inside a bubblewrap namespace.** `claude` is spawned as
`bwrap … -- claude …` with an empty root: new user, pid, ipc, uts, cgroup and
mount namespaces (`--unshare-all`), the network deliberately shared
(`--share-net`), a private `/proc`, a tmpfs `/tmp`, `--new-session` and
`--die-with-parent`. `~/.agent-office/agents`, `~/.pixel-agents` and `~/.claude`
are not bound, so reading them fails with ENOENT. `/mnt`, `/init` and
`/run/WSL` are not bound either, which is what removes WSL's binfmt route to a
Windows process outside the namespace.

**2. Fail closed.** Dispatch probes the sandbox by entering one. If bubblewrap
is missing, or an unprivileged user namespace is refused by policy, no task
runs. There is no unsandboxed fallback, and nothing here changes a host
security setting to make one possible.

**3. One config and one working directory per Agent per Task**, at
`~/.agent-office/runtime/<agentId>/<taskId>/{config,work}`. `CLAUDE_CONFIG_DIR`
points at `config`, so no two Agents and no two Tasks share a Claude
configuration or a transcript, and the operator's own `~/.claude` — settings,
plugins, hooks, MCP servers, every other session — is invisible to a run. The
working directory is fixed per Task, because Claude keys a session's transcript
by working directory and a revision that moved could not resume.

**4. The credential is `CLAUDE_CODE_OAUTH_TOKEN`, from the environment.** A
sandbox has no `~/.claude`, so an interactive login on the host is not
reachable from inside it. It is passed as an environment variable, never on the
command line and never written to a file. `ANTHROPIC_API_KEY` is deliberately
not read: that is a different credential and a different billing route, and
switching silently is not this code's decision. **The run can read its own
environment and write the token anywhere it can write** — being an environment
variable rather than a file is not a guarantee that it stays out of the
filesystem.

**5. The Office control plane requires `privileged`.** Every office message,
and the snapshot pushed during the ready handshake, now needs the server token.
Unprivileged sockets get an `officeError` and nothing else. The embedded VS Code
webview is privileged by construction; the standalone SPA forwards the token
from the printed URL.

**6. A revision resumes only its own Agent's session.** When a Task's assigned
Agent differs from the one that produced the last run, a new session starts.

**7. Workspace paths are resolved before binding.** `realpath` first, then
refuse anything equal to, inside, or an ancestor of the Office data root,
`~/.pixel-agents` or `~/.claude`. A symlink, a `..` or an alias lands on the
same resolved path and is refused there.

**8. The child's environment is an allowlist**, not the parent's. Only `LANG`,
`LC_ALL` and `TZ` are inherited; `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` and the
credential are set explicitly. The Office's own bearer token never travels.

## What this does not do

- **The network is open.** A run reaches the internet and every service on this
  host. Nothing here prevents exfiltration of the project content bound into
  the sandbox or of the credential the run holds. Closing it would cut the API
  connection the run needs.
- **Abstract unix sockets belong to the network namespace**, which is shared,
  so host sockets remain reachable. The authorization in (5) is what protects
  the Office; other local services are not isolated by this work.
- **It binds only what Agent Office starts.** A Claude session the operator
  opens in a terminal is unaffected.

## Verified, and not

Verified on the Linux host this was developed on (`server/__tests__/sandbox.test.ts`,
real bubblewrap): the agents directory is absent inside the namespace, the
project is readable and not writable, only the working directory is writable,
the parent environment is not inherited, and the process list is the sandbox's
own. `CLAUDE_CONFIG_DIR` was confirmed by running the CLI, not by reading its
binary.

**Not verified: any of this on WSL2.** The development host is a Linux
container, not WSL. `npm run verify:wsl2` is the acceptance run for a real
host — one command, no API calls, no installs, no sudo, nothing written
outside a temporary directory. It uses this checkout's build and the product's
own sandbox builder, so it measures what ships rather than a second
configuration written to pass. A check that could not run reports SKIP and the
whole run reports INCOMPLETE; a SKIP never counts as success.

```
npm run verify:wsl2
npm run verify:wsl2 -- --project /mnt/c/Users/you/some-project
```

What it answers on the real host:

1. `bwrap` present and runnable, and an unprivileged user namespace actually
   enterable — with the failure classified as MISSING_BWRAP, MISSING_LIBS,
   BROKEN_BINARY or POLICY (Ubuntu 24.04 ships
   `kernel.apparmor_restrict_unprivileged_userns=1`, which refuses it). The
   script changes no host setting; a POLICY result is a decision to bring back.
2. Inside the namespace the product would build: agent files absent, a bound
   project readable and not writable, the run's own config and work directories
   writable, no inherited environment, its own process list, and `/init`,
   `/mnt` and `/run/WSL` unbound.
3. Workspace path rules, including a symlink that resolves onto office data.
4. A real project path (`--project`): its mount type, and that it binds
   read-only and is readable. Nothing is ever written to a real project.
5. Windows interop **attempted**, not inferred: a copy of `cmd.exe` is executed
   inside the sandbox. If interop does not work outside the sandbox either, the
   result is SKIP — "it did not run" is not "it was blocked".
6. This checkout's server starts, an unauthenticated socket receives no office
   data across the whole handshake and several messages, and an authorized one
   can read and write.

Still outside that run, and still unverified: a real `claude -p` inside the
sandbox authenticating with `CLAUDE_CODE_OAUTH_TOKEN`, and a revision of the
same Task resuming with `--resume`. Both need one paid execution.

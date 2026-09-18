# Agent Office on Windows — first run

Single user, Windows native. Claude Code runs on the same machine.

## Setup, once

1. Install [Node.js 20 or newer](https://nodejs.org) and Claude Code, and sign
   in once with `claude login`. Agent Office uses that existing login — it does
   not ask for a key and does not change how you are billed.
2. In this folder, run `npm ci` then `npm run build`.
3. Double-click **`agent-office.cmd`**, accept the notice it shows, and open the
   address it prints (the address includes the token that authorises the page —
   keep it to yourself).

That is the whole setup. Everything after this is inside the office.

## What the notice is about

On Linux each run is confined to its own namespace: it cannot see your agents'
files and can only write to that task's working directory. **Windows has no
equivalent that ships with the operating system**, so a run there executes with
your own permissions: a command it decides to run can read or change anything
your Windows account can. Claude's own file tools are still denied the Agent
Office data directory, but a shell command is not bound by that.

The approval is recorded in `%USERPROFILE%\.agent-office\windows-shell-consent.json`,
along with the text you accepted. Delete that file to withdraw it; agents then
refuse to run until you accept again.

Two things this does **not** change: the office control plane still requires
the token in the address, and project work still never becomes an agent's
permanent knowledge.

## Using it

1. **Agent Library → Create**, then **Configure** it: instructions, skills,
   knowledge. An agent is global — it is not owned by a project.
2. **Projects → Create**, then **Open** its workspace. Add the agent as a
   member, give the project its context and any project knowledge.
3. **Tasks → Create**, assign the agent, then **Run**.
4. When it finishes the task is in **review**: **View result**, then either
   **Accept** (done) or **Request changes** with feedback, which continues the
   same Claude session and comes back for review again.

Close the window and start `agent-office.cmd` again: projects, tasks, runs,
outputs, feedback and agent configuration are all still there.

## Where your data is

`%USERPROFILE%\.agent-office\`

| Path              | What it holds                                             |
| ----------------- | --------------------------------------------------------- |
| `agent-office.db` | Projects, tasks, memberships, sessions, outputs, feedback |
| `agents\`         | Each agent's instructions, skills and knowledge           |
| `blobs\`          | Project knowledge and task output content                 |
| `runtime\`        | Per-agent, per-task scratch: a run's working directory    |

Back it up by stopping Agent Office and copying `agent-office.db`, `blobs` and
`agents` together. See [backup and restore](backup-and-restore.md) — the
`runtime` folder is scratch and does not need backing up.

## If something stops it

- **"Running agents on Windows needs one-time approval"** — start it with
  `agent-office.cmd` rather than `node dist\cli.js`, and accept the notice.
- **A run fails with an authentication error** — run `claude login` in a
  terminal, then try the task again.
- **The page shows "not authorized"** — open the full address the launcher
  printed, including `?token=…`.

## Not verified on Windows

Developed and tested on Linux. The Windows-specific parts — launching
`claude.cmd` as a child process, and the deny rules covering a Windows path —
have not been exercised on a Windows host. If a run fails to start there, the
error text it reports is the thing to send back.

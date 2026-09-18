# Architecture Decision Records

Two series live here, and they are not the same numbering.

| Series                | Owner                                                                             | Example                                                                 |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **4 digits** `0001-`… | upstream Pixel Agents. Arrives with `git merge upstream/main`; not modified here. | `0001-consent-choices-send-immediately-and-revise-as-absolute-state.md` |
| **3 digits** `001-`…  | Agent Office.                                                                     | `001-project-aggregate-boundary.md`                                     |

## Agent Office ADRs

| #                                                   | Decision                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| [001](001-project-aggregate-boundary.md)            | Project does not embed its agents, tasks, knowledge or outputs                  |
| [002](002-agent-definition-session-separation.md)   | AgentDefinition, AgentSession and Task are three separate things                |
| [003](003-control-plane-runtime-separation.md)      | Control Plane and Agent Runtime are separated, and may not share a machine      |
| [004](004-provider-independent-domain.md)           | The domain depends on no provider, no storage and no UI                         |
| [005](005-global-agents-and-knowledge-ownership.md) | Agents are global; knowledge ownership is strict (amends 001, 002)              |
| [006](006-sqlite-local-persistence.md)              | SQLite is the canonical local store                                             |
| [007](007-agent-file-storage.md)                    | Agent-owned configuration lives in per-agent files, keyed by agent id           |
| [008](008-run-sandbox.md)                           | Claude Code runs inside a bubblewrap namespace; the control plane is privileged |

## Format

Each record uses **Context / Decision / Consequences**. The purpose is that a
later reader can see what was already weighed, so these foundations are not
re-litigated by accident.

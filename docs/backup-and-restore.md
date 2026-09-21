# Backing up and restoring Agent Office

Agent Office keeps its data in one directory, `~/.agent-office` by default:

| Path              | What it holds                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-office.db` | The registry and all operational state: projects, tasks, memberships, sessions, outputs, review notes, and which Agents are file-backed. |
| `blobs/`          | Project knowledge content, task outputs, and the pre-migration copies of Agent knowledge.                                                |
| `agents/`         | **Each Agent's own configuration**: instructions, skills, foundational knowledge. Authoritative — most of it exists nowhere else.        |

All three belong together. `agents/` holds the current Agent configuration,
and `agent-office.db` holds the record of which Agents are file-backed; a
backup of one without the other restores an office that disagrees with itself.

## Backing up

**Stop Agent Office first.** Then copy the three paths:

```bash
# with the office stopped
cp -a ~/.agent-office/agent-office.db ~/.agent-office/blobs ~/.agent-office/agents /path/to/backup/
```

That is the whole procedure. There is no backup UI and no backup service.

### Consistency notes

- The database runs in SQLite's default **rollback-journal** mode
  (`journal_mode = delete`) with `synchronous = FULL`. There are no `-wal` or
  `-shm` files to worry about.
- With the office stopped, `agent-office.db` is a complete, consistent file on
  its own.
- If you copy while the office is **running**, a transient
  `agent-office.db-journal` may exist next to it; copying the database without
  it can leave you with a file that rolls back a half-finished transaction on
  open, and the `agents/` tree may be mid-write. Stop the office instead.
- Agent files are written through a temporary file and renamed, so an
  individual file is never half-written — but a backup taken mid-operation can
  still catch the database and the files at different moments.

## Restoring

**Stop Agent Office first.** Then put all three back, together:

```bash
# with the office stopped
rm -rf ~/.agent-office/agent-office.db ~/.agent-office/blobs ~/.agent-office/agents
cp -a /path/to/backup/agent-office.db /path/to/backup/blobs /path/to/backup/agents ~/.agent-office/
```

Start the office. Agents that were file-backed in the backup are file-backed
again, with the instructions, skills and knowledge they had when it was taken.

`server/__tests__/agentFilesLifecycle.test.ts` runs exactly this cycle against
a real server in a temporary data root, including edits, additions and
deletions made after the migration.

## What the legacy database can and cannot recover

The rows in `skills` and `agent_knowledge`, and the `system_prompt` column on
`agents`, are the **pre-migration** copies. They were left in place
deliberately, but they are not a backup:

- They hold what each Agent looked like when it moved to files, and nothing
  since. A skill added afterwards, an edited instruction or a deleted item is
  not in them.
- Deleting an Agent's directory to "reset it from the database" therefore
  destroys real data. Do not do it.

If an Agent's files are missing, Agent Office says so rather than quietly
serving those old rows: the agent shows as not file-backed with an explanation,
configuration edits are refused, and starting one of its tasks fails with the
same message. Restore `agents/` from a backup.

If you have no backup and no files, the pre-migration rows are all that is
left. Recovering from them is a deliberate, manual decision — there is no
command that does it for you, because it silently reverts an Agent to an older
version of itself.

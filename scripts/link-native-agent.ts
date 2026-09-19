/**
 * Register a Claude Code NATIVE subagent file (`~/.claude/agents/<name>.md`,
 * created and maintained by Claude Code itself) as an Office Agent.
 *
 * Office never copies the file's content: it stores only the association
 * (see `linkNativeAgent.ts` / `OfficeAgentMeta.nativeAgentPath`), and every
 * later read — Office's own display, and every task dispatch — re-reads the
 * file fresh. Running this again for the same path is how a change made in
 * Claude Code is picked up; it updates the same agent rather than creating a
 * second one.
 *
 *   npm run link-native-agent -- ~/.claude/agents/my-agent.md
 *
 * This opens the REAL `~/.agent-office` database (not a throwaway one, and
 * not overridable except for this script's own tests) — close Office (the
 * VS Code extension window, or the standalone `pixel-agents` process) before
 * running it, and reopen it afterward to see the linked agent. Two processes
 * opening the same SQLite file at once is not something this script tries to
 * make safe.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { systemClock, uuidIdGenerator } from '../domain/src/index.js';
import { linkNativeAgentFile, openSqliteStorage } from '../storage/src/index.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    console.log(
      'Usage: npm run link-native-agent -- <path to a Claude Code agent .md file>\n' +
        '  e.g. npm run link-native-agent -- ~/.claude/agents/my-agent.md',
    );
    process.exit(arg ? 0 : 1);
  }
  const filePath = expandHome(arg!);

  const storage = openSqliteStorage();
  try {
    const result = await linkNativeAgentFile(storage.repos, storage.agentFiles, filePath, {
      ids: uuidIdGenerator,
      clock: systemClock,
    });
    if (!result.ok) {
      console.error(`Not linked: ${result.reason}`);
      process.exit(1);
    }
    console.log(
      `${result.action === 'linked' ? 'Linked' : 'Refreshed'}: "${result.agent.name}" ` +
        `(agent id ${result.agent.id}) from ${path.resolve(filePath)}`,
    );
    console.log(
      result.action === 'linked'
        ? 'Open Office and add this agent to a project to give it a task.'
        : "Office's copy of this agent's name/description/instructions/tools/model is refreshed from the file.",
    );
  } finally {
    storage.close();
  }
}

function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

export { main };

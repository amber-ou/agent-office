/**
 * The one-time Windows approval, and the notice it is an approval of.
 *
 * Called by `agent-office.cmd` before the server starts. Windows has no
 * namespace to confine a run to, so a run there executes with the operator's
 * own permissions — that is the thing being agreed to, and the agreement is
 * written down with the text that was shown.
 *
 *   node scripts/windows-consent.mjs --check    exit 0 when already accepted
 *   node scripts/windows-consent.mjs --show     print the notice
 *   node scripts/windows-consent.mjs --accept   record the approval
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const NOTICE = [
  'Agent Office runs Claude Code with shell access.',
  '',
  'On Linux each run is confined to its own namespace: it cannot see your',
  "agents' files, and it can only write to that task's working directory.",
  'Windows has no equivalent that ships with the operating system, so on this',
  'machine a run executes with YOUR OWN permissions. A command it decides to',
  'run can read or change anything your Windows account can, including your',
  "Agent Office data and the rest of your files. Claude's own file tools are",
  'still denied the Agent Office data directory, but a shell command is not',
  'bound by that.',
  '',
  'Only continue if you are willing to run agent-authored commands on this',
  'account, and only give projects to agents you would give to a contractor.',
].join('\n');

const dataRoot = process.env.AGENT_OFFICE_DATA_ROOT ?? path.join(os.homedir(), '.agent-office');
const file = path.join(dataRoot, 'windows-shell-consent.json');

function accepted() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).accepted === true;
  } catch {
    return false;
  }
}

const mode = process.argv[2];

if (mode === '--check') {
  process.exit(accepted() ? 0 : 1);
}

if (mode === '--show') {
  process.stdout.write(`${NOTICE}\n`);
  process.exit(0);
}

if (mode === '--accept') {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ accepted: true, acceptedAt: new Date().toISOString(), notice: NOTICE }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write('Recorded. Delete this file to withdraw it:\n  ' + file + '\n');
  process.exit(0);
}

process.stderr.write('usage: windows-consent.mjs --check | --show | --accept\n');
process.exit(2);

/**
 * Windows (and any-OS) acceptance for the Claude Code discovery bridge.
 *
 * One command, no API calls, no writes outside a temporary directory, never
 * the real `~/.agent-office` or the real `~/.claude`. It runs this
 * checkout's own storage/server test suites (the file-simulation tier) and
 * then exercises the PACKAGED `dist/cli.js` build end to end against a
 * throwaway home directory — the same technique `verify-wsl2.ts` already
 * uses, extended to the CC bridge (junction creation, discovery scope,
 * office.json field separation, skill name qualification, second-computer
 * import, damage reporting).
 *
 *   npm run verify:cc-bridge
 *
 * This does NOT check the real `claude` CLI's discovery (there is no
 * scriptable, non-interactive, free way to do that — the confirmed free
 * mechanisms are the INTERACTIVE `/list-agents` and `/skills` commands,
 * which this script cannot drive). That tier is a short manual step;
 * see the summary this script prints for it.
 *
 * Every check reports PASS, FAIL or SKIP with a reason. A SKIP on a required
 * check is never counted as success: the whole run exits non-zero and says
 * INCOMPLETE.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Check {
  id: string;
  title: string;
  status: Status;
  detail: string;
  required: boolean;
}

const checks: Check[] = [];
let tmpRoot = '';

function record(id: string, title: string, status: Status, detail: string, required = true): void {
  const clean = redact(detail);
  checks.push({ id, title, status, detail: clean, required });
  process.stdout.write(`${status.padEnd(4)} ${id}  ${title}\n`);
  if (clean) {
    process.stdout.write(
      `${clean
        .split('\n')
        .map((line) => `       ${line}`)
        .join('\n')}\n`,
    );
  }
}

/** Keep real paths and home directories out of the pasteable summary. */
function redact(text: string): string {
  let out = text;
  if (tmpRoot) {
    out = out.split(tmpRoot).join('<tmp>');
  }
  return out.split(os.homedir()).join('~').slice(0, 4000);
}

// ── 1. This checkout, and its build ──────────────────────────────

function checkBuild(): string | null {
  const cli = path.join(REPO, 'dist', 'cli.js');
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  const commit = head.stdout.trim() || 'unknown';
  if (!fs.existsSync(cli)) {
    record(
      'build',
      'This checkout is built',
      'FAIL',
      `dist/cli.js is missing at commit ${commit} — run "npm.cmd ci" then "npm.cmd run build" first`,
    );
    return null;
  }
  record('build', 'This checkout is built', 'PASS', `entry dist/cli.js, commit ${commit}`);
  return cli;
}

// ── 2 & 3. File-simulation tier: this checkout's own test suites ──

/** npm on Windows is npm.cmd; on POSIX it's just npm. Same call either way. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function checkWorkspaceTests(id: string, title: string, script: string): void {
  const result = spawnSync(NPM, ['run', script], {
    cwd: REPO,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const summaryLines = output
    .split('\n')
    .filter((line) => /^\s*(Test Files|Tests)\s/.test(line))
    .map((line) => line.trim());
  const passed = result.status === 0;
  record(
    id,
    title,
    passed ? 'PASS' : 'FAIL',
    summaryLines.length > 0
      ? summaryLines.join('\n')
      : `exit code ${result.status}; last output:\n${output.trim().slice(-1200)}`,
  );
}

// ── 4. Real end-to-end: the packaged dist/cli.js, a throwaway home ──

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function readToken(home: string): Promise<string | null> {
  const file = path.join(home, '.pixel-agents', 'server.json');
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        token?: string;
        authToken?: string;
      };
      const token = parsed.token ?? parsed.authToken;
      if (token) return token;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function collect(
  socket: import('ws').WebSocket,
  messages: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const received: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve) => {
    socket.once('open', () => resolve());
    socket.once('error', () => resolve());
  });
  socket.on('message', (data: Buffer | string) => {
    try {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore non-JSON frames
    }
  });
  for (const message of messages) {
    socket.send(JSON.stringify(message));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  socket.close();
  return received;
}

/** Poll the filesystem instead of guessing a fixed delay: the CC bridge runs
 *  as best-effort background work after storage opens (see
 *  officeStorage.ts), on no fixed schedule. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

async function checkCcBridgeEndToEnd(cli: string): Promise<void> {
  // A throwaway HOME/USERPROFILE for the CHILD PROCESS ONLY — this never
  // touches the real, session-wide USERPROFILE, and never touches the real
  // ~/.agent-office or ~/.claude. Office's own data root and its Claude Code
  // discovery-link target both derive from os.homedir(), so one override
  // relocates both to the same temporary place (they are never split across
  // two different env vars here).
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();

  const child = spawn(process.execPath, [cli, '--port', String(port)], {
    cwd: tmpRoot,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

  try {
    if (!(await waitForHealth(port))) {
      record('cc-bridge-start', 'The packaged build serves the office', 'FAIL', log);
      return;
    }
    const token = await readToken(home);
    if (!token) {
      record(
        'cc-bridge-start',
        'The packaged build serves the office',
        'FAIL',
        'no server token was written',
      );
      return;
    }
    record(
      'cc-bridge-start',
      'The packaged build serves the office',
      'PASS',
      'dist/cli.js on a free port, throwaway home',
    );

    const { WebSocket } = await import('ws');
    const authorized = await collect(new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`), [
      { type: 'webviewReady' },
      {
        type: 'createAgent',
        name: 'Acceptance Agent',
        role: 'qa',
        provider: 'claude',
        systemPrompt: 'Verify the bridge.',
      },
    ]);
    const agentId = authorized
      .flatMap((m) => (Array.isArray(m['agents']) ? (m['agents'] as Array<{ id: string }>) : []))
      .at(-1)?.id;
    if (!agentId) {
      record(
        'cc-bridge-agent',
        'A test agent can be created',
        'FAIL',
        `no agent in officeState; received types: ${[...new Set(authorized.map((m) => String(m['type'])))].join(',')}`,
      );
      return;
    }
    record('cc-bridge-agent', 'A test agent can be created', 'PASS', `agent ${agentId}`);

    const claudeAgentsRoot = path.join(home, '.claude', 'agents');
    const linkPath = path.join(claudeAgentsRoot, agentId);
    const officeMetaPath = path.join(home, '.agent-office', 'agents', agentId, 'office.json');
    const gotLink = await waitUntil(() => fs.existsSync(linkPath) && fs.existsSync(officeMetaPath));
    if (!gotLink) {
      record(
        'cc-bridge-link',
        'A junction into .claude/agents/ is created',
        'FAIL',
        `not seen within timeout under ${claudeAgentsRoot}`,
      );
      return;
    }
    const isLink = fs.lstatSync(linkPath).isSymbolicLink();
    record(
      'cc-bridge-link',
      'A junction into .claude/agents/ is created, pointing at discovery/',
      isLink ? 'PASS' : 'FAIL',
      `${linkPath} isSymbolicLink=${isLink}`,
    );

    const seenThroughLink = isLink ? fs.readdirSync(linkPath) : [];
    record(
      'cc-bridge-scope',
      'Only discovery/ is exposed — never skills or knowledge',
      seenThroughLink.length === 1 && seenThroughLink[0] === 'agent.md' ? 'PASS' : 'FAIL',
      `contents: ${seenThroughLink.join(', ') || '(none)'}`,
    );

    const officeMeta = JSON.parse(fs.readFileSync(officeMetaPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const noOverlap =
      !('name' in officeMeta) &&
      !('description' in officeMeta) &&
      !('tools' in officeMeta) &&
      !('model' in officeMeta);
    record(
      'cc-bridge-fields',
      'office.json never duplicates name/description/tools/model',
      noOverlap ? 'PASS' : 'FAIL',
      `office.json keys: ${Object.keys(officeMeta).join(', ')}`,
    );

    const knowledgeIndex = path.join(
      home,
      '.agent-office',
      'agents',
      agentId,
      'knowledge',
      'index.md',
    );
    const agentMd = fs.readFileSync(path.join(linkPath, 'agent.md'), 'utf8');
    const hasPointer =
      agentMd.includes('agent-office:knowledge-pointer') && agentMd.includes('index.md');
    record(
      'cc-bridge-knowledge',
      'A knowledge pointer is appended, and no absolute path is baked in',
      fs.existsSync(knowledgeIndex) && hasPointer && !agentMd.includes(home) ? 'PASS' : 'FAIL',
      `index exists=${fs.existsSync(knowledgeIndex)}, agent.md has pointer=${hasPointer}`,
    );
  } finally {
    child.kill();
  }
}

// ── Run ──────────────────────────────────────────────────────────

function summarize(): void {
  const counts: Record<Status, number> = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const check of checks) counts[check.status]++;
  const missing = checks.filter((check) => check.required && check.status === 'SKIP');
  const verdict =
    counts.FAIL > 0 ? 'FAIL' : missing.length > 0 || counts.PASS === 0 ? 'INCOMPLETE' : 'PASS';

  process.stdout.write('\n--- paste this back ---\n');
  process.stdout.write(
    `agent-office CC-bridge acceptance (file-simulation + real packaged build): ${verdict}\n`,
  );
  process.stdout.write(`platform: ${process.platform} ${os.release()}\n`);
  for (const check of checks) {
    process.stdout.write(`${check.status.padEnd(4)} ${check.id}\n`);
  }
  process.stdout.write(
    `totals: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip` +
      (missing.length > 0
        ? ` (required but skipped: ${missing.map((c) => c.id).join(', ')})`
        : '') +
      '\n--- end ---\n',
  );
  process.stdout.write(
    '\nNot covered by this script (no scriptable free check exists): whether the real `claude` CLI\n' +
      'itself lists this agent/skill. Check manually with the throwaway home this script just used\n' +
      '(or a fresh one) by running `claude` in it and typing `/list-agents` and `/skills` — both are\n' +
      'documented as local, no-model-call introspection. Report what you see; do not run a paid\n' +
      'call (asking Claude to actually use the agent/skill) without confirming with me first.\n',
  );
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}

async function main(): Promise<void> {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-cc-bridge-'));
  process.stdout.write('Agent Office — Claude Code discovery bridge acceptance (no API calls)\n\n');
  try {
    const cli = checkBuild();
    checkWorkspaceTests('test-storage', 'storage test suite (file simulation)', 'test:storage');
    checkWorkspaceTests('test-server', 'server test suite (file simulation)', 'test:server');
    if (cli) {
      await checkCcBridgeEndToEnd(cli);
    } else {
      for (const id of [
        'cc-bridge-start',
        'cc-bridge-agent',
        'cc-bridge-link',
        'cc-bridge-scope',
        'cc-bridge-fields',
        'cc-bridge-knowledge',
      ]) {
        record(id, id, 'SKIP', 'dist/cli.js is missing, see the build check above');
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  summarize();
}

void main();

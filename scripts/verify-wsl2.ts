/**
 * WSL2 acceptance for the run sandbox and the Office control plane.
 *
 * One command, no API calls, no installs, no sudo, nothing written outside a
 * temporary directory. It answers the questions ADR 008 left open on a real
 * WSL2 host, using the PRODUCT's own sandbox builder and this checkout's own
 * build — a second, hand-written bwrap configuration would prove nothing about
 * what actually ships.
 *
 *   npm run verify:wsl2
 *   npm run verify:wsl2 -- --project /mnt/c/Users/you/some-project
 *
 * Every check reports PASS, FAIL or SKIP with a reason. A SKIP is never
 * counted as success: if a check that had to run did not, the whole thing exits
 * non-zero and says INCOMPLETE. Absolute paths are redacted, so the summary can
 * be pasted back as it is.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSandboxArgv, resolveBindPath, SandboxPathError } from '../runtime/src/sandbox.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'AGENT-PRIVATE-MARKER';
const FIXTURE_AGENT_ID = '11111111-1111-4111-8111-111111111111';

type Status = 'PASS' | 'FAIL' | 'SKIP';

interface Check {
  id: string;
  title: string;
  status: Status;
  detail: string;
  /** A SKIP here means the run is incomplete, not that it passed. */
  required: boolean;
}

const checks: Check[] = [];
let tmpRoot = '';

function record(id: string, title: string, status: Status, detail: string, required = true): void {
  const clean = redact(detail);
  checks.push({ id, title, status, detail: clean, required });
  process.stdout.write(`${status.padEnd(4)} ${id}  ${title}\n`);
  if (clean) {
    process.stdout.write(`       ${clean}\n`);
  }
}

/** Keep real paths and home directories out of the pasteable summary. */
function redact(text: string): string {
  let out = text;
  if (tmpRoot) {
    out = out.split(tmpRoot).join('<tmp>');
  }
  return out.split(os.homedir()).join('~').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function projectArg(): string | undefined {
  const index = process.argv.indexOf('--project');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// ── 1. This checkout, and its build ──────────────────────────────

function checkBuild(): string | null {
  const cli = path.join(REPO, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    record(
      'build',
      'This checkout is built',
      'FAIL',
      'dist/cli.js is missing — run `npm run build` first',
    );
    return null;
  }
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  record(
    'build',
    'This checkout is built',
    'PASS',
    `entry dist/cli.js, commit ${head.stdout.trim() || 'unknown'}`,
  );
  return cli;
}

// ── 2. Can a namespace be created at all, and if not, why ────────

function readSysctl(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function checkSandboxAvailable(): boolean {
  const version = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  if (version.error) {
    const code = (version.error as NodeJS.ErrnoException).code;
    record(
      'bwrap',
      'bubblewrap is installed and runnable',
      'FAIL',
      code === 'ENOENT'
        ? 'MISSING_BWRAP: no bwrap on PATH. Nothing here installs it.'
        : `LAUNCH_ERROR: ${version.error.message}`,
    );
    return false;
  }
  if (version.status !== 0) {
    const stderr = String(version.stderr ?? '');
    record(
      'bwrap',
      'bubblewrap is installed and runnable',
      'FAIL',
      /shared libraries|cannot open shared object/i.test(stderr)
        ? `MISSING_LIBS: ${stderr}`
        : `BROKEN_BINARY: exit ${version.status} ${stderr}`,
    );
    return false;
  }
  record('bwrap', 'bubblewrap is installed and runnable', 'PASS', version.stdout.trim());

  // Entering one is the only real test: the binary can be perfectly fine and
  // the host policy still refuse an unprivileged user namespace.
  const probe = spawnSync(
    'bwrap',
    [
      '--unshare-all',
      '--share-net',
      // The same binds the product's own probe uses: enough userland for the
      // probe's command to exist, so a failure means the namespace, not a
      // missing /bin.
      '--ro-bind-try',
      '/usr',
      '/usr',
      '--ro-bind-try',
      '/bin',
      '/bin',
      '--ro-bind-try',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--',
      '/bin/true',
    ],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) {
    record('userns', 'An unprivileged user namespace can be created', 'PASS', '');
    return true;
  }

  const stderr = String(probe.stderr ?? '').trim();
  const apparmor = readSysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  const maxUserns = readSysctl('/proc/sys/user/max_user_namespaces');
  const policy =
    apparmor === '1' ||
    maxUserns === '0' ||
    /operation not permitted|uid map|namespace/i.test(stderr);
  record(
    'userns',
    'An unprivileged user namespace can be created',
    'FAIL',
    policy
      ? `POLICY: refused by host policy (apparmor_restrict_unprivileged_userns=${apparmor ?? 'n/a'}, max_user_namespaces=${maxUserns ?? 'n/a'}). ${stderr} This script changes no host setting.`
      : `UNKNOWN: exit ${probe.status} ${stderr}`,
  );
  return false;
}

// ── 3. What the product's own sandbox actually lets through ──────

interface Fixtures {
  dataRoot: string;
  agentFile: string;
  project: string;
  configDir: string;
  workDir: string;
}

function makeFixtures(): Fixtures {
  const dataRoot = path.join(tmpRoot, '.agent-office');
  const agentDir = path.join(dataRoot, 'agents', FIXTURE_AGENT_ID);
  const project = path.join(tmpRoot, 'fixture-project');
  const configDir = path.join(dataRoot, 'runtime', 'agent', 'task', 'config');
  const workDir = path.join(dataRoot, 'runtime', 'agent', 'task', 'work');
  for (const dir of [agentDir, project, configDir, workDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const agentFile = path.join(agentDir, 'discovery', 'agent.md');
  fs.writeFileSync(agentFile, MARKER);
  fs.writeFileSync(path.join(project, 'README.md'), 'FIXTURE PROJECT');
  return { dataRoot, agentFile, project, configDir, workDir };
}

/** Run a shell script inside the sandbox the product would build for a run. */
function insideSandbox(
  fixtures: Fixtures,
  script: string,
  readOnlyPaths: string[] = [fixtures.project],
): { output: string; status: number } {
  const argv = [
    ...buildSandboxArgv({
      configDir: fixtures.configDir,
      workDir: fixtures.workDir,
      readOnlyPaths,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-not-a-real-token' },
    }),
    '/bin/sh',
    '-c',
    script,
  ];
  const result = spawnSync('bwrap', argv, {
    encoding: 'utf8',
    env: { PARENT_SECRET: 'must-not-be-inherited' },
  });
  return { output: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status ?? -1 };
}

function checkNamespaceBehaviour(fixtures: Fixtures): void {
  const agents = insideSandbox(fixtures, `cat ${fixtures.agentFile} 2>&1`);
  record(
    'agents-hidden',
    'Agent private files are not in the namespace',
    !agents.output.includes(MARKER) && /no such file/i.test(agents.output) ? 'PASS' : 'FAIL',
    agents.output,
  );

  const write = insideSandbox(fixtures, `echo tampered > ${fixtures.project}/README.md 2>&1`);
  const unchanged = fs.readFileSync(path.join(fixtures.project, 'README.md'), 'utf8');
  record(
    'project-ro',
    'A bound project is readable and not writable (fixture)',
    write.status !== 0 && unchanged === 'FIXTURE PROJECT' ? 'PASS' : 'FAIL',
    write.output,
  );

  const work = insideSandbox(fixtures, 'echo output > ./result.md && echo WORK_OK');
  const config = insideSandbox(fixtures, `echo x > ${fixtures.configDir}/probe && echo CONFIG_OK`);
  record(
    'work-rw',
    'The run has its own writable config and work directories',
    work.output.includes('WORK_OK') && config.output.includes('CONFIG_OK') ? 'PASS' : 'FAIL',
    `${work.output} ${config.output}`,
  );

  const env = insideSandbox(
    fixtures,
    'echo "SECRET=[$PARENT_SECRET]"; ls /proc | grep -c "^[0-9]*$"',
  );
  const pids = Number(env.output.trim().split('\n').at(-1));
  record(
    'isolation',
    'No parent environment, and its own process list',
    env.output.includes('SECRET=[]') && Number.isFinite(pids) && pids < 10 ? 'PASS' : 'FAIL',
    env.output,
  );

  const wsl = insideSandbox(fixtures, 'ls -d /init /run/WSL /mnt 2>&1');
  record(
    'wsl-paths-absent',
    'WSL interop paths are not bound into the namespace',
    /no such file/i.test(wsl.output) && !/^\/init$/m.test(wsl.output) ? 'PASS' : 'FAIL',
    wsl.output,
  );
}

// ── 4. Path rules, with no writes anywhere ───────────────────────

function checkPathRules(fixtures: Fixtures): void {
  const forbidden = {
    officeDataRoot: fixtures.dataRoot,
    others: [path.join(os.homedir(), '.pixel-agents'), path.join(os.homedir(), '.claude')],
  };
  const resolve = (p: string): string => fs.realpathSync(p);
  const failures: string[] = [];

  try {
    resolveBindPath(fixtures.project, forbidden, resolve);
  } catch (error) {
    failures.push(`ordinary project refused: ${String(error)}`);
  }

  const alias = path.join(tmpRoot, 'alias-to-agents');
  fs.symlinkSync(path.join(fixtures.dataRoot, 'agents'), alias);
  for (const bad of [fixtures.dataRoot, path.join(fixtures.dataRoot, 'agents'), alias, '/']) {
    try {
      resolveBindPath(bad, forbidden, resolve);
      failures.push(`accepted a path it must refuse: ${bad}`);
    } catch (error) {
      if (!(error instanceof SandboxPathError)) {
        failures.push(`wrong error for ${bad}: ${String(error)}`);
      }
    }
  }

  record(
    'path-rules',
    'Workspace paths are resolved, and office data is refused',
    failures.length === 0 ? 'PASS' : 'FAIL',
    failures.join('; '),
  );
}

// ── 5. The real project: mount type, and readable (never written) ─

function checkRealProject(fixtures: Fixtures, project: string | undefined): void {
  if (!project) {
    record(
      'project-mount',
      'The real project binds read-only and its mount is known',
      'SKIP',
      'no --project <path> given',
      false,
    );
    return;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(project);
  } catch (error) {
    record('project-mount', 'The real project binds read-only', 'FAIL', String(error), false);
    return;
  }

  const mount = spawnSync('findmnt', ['-no', 'FSTYPE,SOURCE', '--target', resolved], {
    encoding: 'utf8',
  });
  const fstype = mount.status === 0 ? mount.stdout.trim() : 'unknown';

  // Read only. Nothing in this script writes to a real project.
  const listing = insideSandbox(fixtures, `ls -a ${resolved} | head -3`, [resolved]);
  record(
    'project-mount',
    'The real project binds read-only and is readable',
    listing.status === 0 ? 'PASS' : 'FAIL',
    `fstype=${fstype}; nothing was written here — the read-only enforcement is the fixture check above`,
    false,
  );
}

// ── 6. Windows interop, actually attempted ───────────────────────

function checkInterop(fixtures: Fixtures): void {
  const exe = ['/mnt/c/Windows/System32/cmd.exe', '/mnt/c/Windows/system32/cmd.exe'].find(
    (candidate) => fs.existsSync(candidate),
  );
  if (!exe) {
    record(
      'interop',
      'A Windows executable cannot run inside the sandbox',
      'SKIP',
      'no cmd.exe under /mnt/c, so interop could not be attempted and nothing is proven',
      false,
    );
    return;
  }

  // Outside first: if interop does not work here anyway, the inside result
  // proves nothing at all.
  const outside = spawnSync(exe, ['/c', 'echo', 'HOST_INTEROP_OK'], { encoding: 'utf8' });
  if (outside.status !== 0 || !String(outside.stdout).includes('HOST_INTEROP_OK')) {
    record(
      'interop',
      'A Windows executable cannot run inside the sandbox',
      'SKIP',
      'interop does not work outside the sandbox either, so this could not be verified',
      false,
    );
    return;
  }

  // A copy inside the run's own writable directory, so the executable is
  // present and reachable and only binfmt decides.
  const copy = path.join(fixtures.workDir, 'cmd.exe');
  fs.copyFileSync(exe, copy);
  const inside = insideSandbox(fixtures, './cmd.exe /c echo SANDBOX_INTEROP_OK 2>&1');
  fs.rmSync(copy, { force: true });
  record(
    'interop',
    'A Windows executable cannot run inside the sandbox',
    inside.output.includes('SANDBOX_INTEROP_OK') ? 'FAIL' : 'PASS',
    `outside=ok, inside=${inside.output || 'refused'}`,
  );
}

// ── 7. The Office control plane, from this checkout's build ──────

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
      if (response.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** The server writes its discovery file shortly after it starts listening. */
async function readToken(home: string): Promise<string | null> {
  const file = path.join(home, '.pixel-agents', 'server.json');
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      // The field is `token`; `authToken` is accepted too, because that is
      // what the architecture notes call it and the two have drifted.
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        token?: string;
        authToken?: string;
      };
      const token = parsed.token ?? parsed.authToken;
      if (token) {
        return token;
      }
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Send several messages and collect EVERYTHING that comes back, rather than
 * stopping at the first reply: a leak could arrive during the handshake, or
 * after the refusal.
 */
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

async function checkOffice(cli: string): Promise<void> {
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();

  // A temporary HOME, so this touches neither the real office data nor the
  // real Claude configuration.
  const child = spawn(process.execPath, [cli, '--port', String(port)], {
    cwd: tmpRoot,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });

  try {
    if (!(await waitForHealth(port))) {
      record('office-start', 'This checkout serves the office', 'FAIL', log);
      return;
    }
    record('office-start', 'This checkout serves the office', 'PASS', 'dist/cli.js on a free port');

    const token = await readToken(home);
    if (!token) {
      const dir = path.join(home, '.pixel-agents');
      const seen = fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : 'no .pixel-agents';
      record(
        'office-auth',
        'Unauthorized clients get no office data',
        'FAIL',
        `no server token was written (saw: ${seen}); server log tail: ${log.slice(-200)}`,
      );
      return;
    }

    const { WebSocket } = await import('ws');
    const anonymous = await collect(new WebSocket(`ws://127.0.0.1:${port}/ws`), [
      { type: 'webviewReady' },
      { type: 'requestOffice' },
      { type: 'requestAgentDetail', agentId: FIXTURE_AGENT_ID },
      { type: 'createProject', name: 'should-not-exist' },
    ]);
    const leaked = anonymous.filter(
      (m) => m['type'] === 'officeState' || m['type'] === 'agentDetail',
    );
    record(
      'office-auth',
      'Unauthorized clients get no office data, across the whole handshake',
      leaked.length === 0 && anonymous.some((m) => m['type'] === 'officeError') ? 'PASS' : 'FAIL',
      `received: ${[...new Set(anonymous.map((m) => String(m['type'])))].join(',') || 'nothing'}`,
    );

    const authorized = await collect(new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`), [
      { type: 'webviewReady' },
      { type: 'requestOffice' },
      { type: 'createProject', name: 'Acceptance' },
      { type: 'createAgent', name: 'Acceptance Agent', role: 'qa', provider: 'claude' },
    ]);
    const states = authorized.filter((m) => m['type'] === 'officeState');
    const agents = states.at(-1)?.['agents'];
    const projects = states.at(-1)?.['projects'];
    record(
      'office-authorized',
      'An authorized client can read and write office data',
      Array.isArray(agents) &&
        agents.length === 1 &&
        Array.isArray(projects) &&
        projects.length === 1
        ? 'PASS'
        : 'FAIL',
      `officeState messages: ${states.length}`,
    );
  } finally {
    child.kill();
  }
}

// ── Run ──────────────────────────────────────────────────────────

const SANDBOX_DEPENDENT: ReadonlyArray<readonly [string, string, boolean]> = [
  ['agents-hidden', 'Agent private files are not in the namespace', true],
  ['project-ro', 'A bound project is readable and not writable (fixture)', true],
  ['work-rw', 'The run has its own writable config and work directories', true],
  ['isolation', 'No parent environment, and its own process list', true],
  ['wsl-paths-absent', 'WSL interop paths are not bound into the namespace', true],
  ['project-mount', 'The real project binds read-only and its mount is known', false],
  ['interop', 'A Windows executable cannot run inside the sandbox', false],
];

function summarize(): void {
  const counts: Record<Status, number> = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const check of checks) {
    counts[check.status]++;
  }
  const missing = checks.filter((check) => check.required && check.status === 'SKIP');
  const verdict =
    counts.FAIL > 0 ? 'FAIL' : missing.length > 0 || counts.PASS === 0 ? 'INCOMPLETE' : 'PASS';

  process.stdout.write('\n--- paste this back ---\n');
  process.stdout.write(`agent-office WSL2 acceptance: ${verdict}\n`);
  process.stdout.write(`kernel: ${os.release()}\n`);
  for (const check of checks) {
    process.stdout.write(
      `${check.status.padEnd(4)} ${check.id}${check.detail ? ` — ${check.detail}` : ''}\n`,
    );
  }
  process.stdout.write(
    `totals: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip` +
      (missing.length > 0
        ? ` (required but skipped: ${missing.map((c) => c.id).join(', ')})`
        : '') +
      '\n--- end ---\n',
  );
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}

async function main(): Promise<void> {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-wsl2-'));
  process.stdout.write('Agent Office — WSL2 acceptance (no API calls, no installs, no sudo)\n\n');
  try {
    const cli = checkBuild();
    const fixtures = makeFixtures();
    checkPathRules(fixtures);

    if (checkSandboxAvailable()) {
      checkNamespaceBehaviour(fixtures);
      checkRealProject(fixtures, projectArg());
      checkInterop(fixtures);
    } else {
      for (const [id, title, required] of SANDBOX_DEPENDENT) {
        record(id, title, 'SKIP', 'no usable sandbox, so nothing here was proven', required);
      }
    }

    if (cli) {
      await checkOffice(cli);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  summarize();
}

void main();

/**
 * The run sandbox: what one Claude Code execution can see.
 *
 * The argv builder and the path rules are unit-tested; the last block actually
 * enters a bubblewrap namespace and checks the filesystem from inside it,
 * because "the path is not in the namespace" is a claim about the OS, not
 * about our code. It skips where bubblewrap is unavailable rather than
 * pretending to have proven anything.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSandboxArgv,
  INHERITED_ENV_KEYS,
  inheritedEnv,
  resolveBindPath,
  SandboxPathError,
} from '../../runtime/src/index.js';

const bwrapAvailable = spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0;

let root: string;
let dataRoot: string;
let project: string;
let configDir: string;
let workDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-sandbox-'));
  dataRoot = path.join(root, '.agent-office');
  project = path.join(root, 'project');
  configDir = path.join(dataRoot, 'runtime', 'agent', 'task', 'config');
  workDir = path.join(dataRoot, 'runtime', 'agent', 'task', 'work');
  for (const dir of [path.join(dataRoot, 'agents'), project, configDir, workDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataRoot, 'agents', 'instructions.md'), 'AGENT SECRET');
  fs.writeFileSync(path.join(project, 'README.md'), 'PROJECT CONTENT');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function spec(readOnlyPaths: string[] = [project]) {
  return { configDir, workDir, readOnlyPaths, env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } };
}

describe('workspace path rules', () => {
  const resolve = (p: string): string => fs.realpathSync(p);

  it('accepts an ordinary project directory', () => {
    expect(resolveBindPath(project, { officeDataRoot: dataRoot }, resolve)).toBe(
      fs.realpathSync(project),
    );
  });

  it('refuses the office data root, anything inside it, and any ancestor of it', () => {
    for (const bad of [dataRoot, path.join(dataRoot, 'agents'), root]) {
      expect(() => resolveBindPath(bad, { officeDataRoot: dataRoot }, resolve)).toThrow(
        SandboxPathError,
      );
    }
  });

  it('refuses an alias that resolves onto office data', () => {
    // A symlink, a `..` and a doubled slash all land on the same resolved path,
    // which is why the check is on the resolved one.
    const alias = path.join(root, 'looks-harmless');
    fs.symlinkSync(path.join(dataRoot, 'agents'), alias);
    expect(() => resolveBindPath(alias, { officeDataRoot: dataRoot }, resolve)).toThrow(
      /overlaps Agent Office's private data/,
    );
    expect(() =>
      resolveBindPath(
        path.join(project, '..', '.agent-office'),
        { officeDataRoot: dataRoot },
        resolve,
      ),
    ).toThrow(SandboxPathError);
  });

  it('refuses the filesystem root and a path that does not exist', () => {
    expect(() => resolveBindPath('/', { officeDataRoot: dataRoot }, resolve)).toThrow(
      SandboxPathError,
    );
    expect(() =>
      resolveBindPath(path.join(root, 'nope'), { officeDataRoot: dataRoot }, resolve),
    ).toThrow(/does not exist/);
  });

  it('also refuses the other private roots it is given', () => {
    const claude = path.join(root, '.claude');
    fs.mkdirSync(claude);
    expect(() =>
      resolveBindPath(claude, { officeDataRoot: dataRoot, others: [claude] }, resolve),
    ).toThrow(SandboxPathError);
  });
});

describe('sandbox arguments', () => {
  it('builds a namespace with only the run-s own paths in it', () => {
    const argv = buildSandboxArgv(spec());
    const joined = argv.join(' ');

    expect(argv).toContain('--unshare-all');
    expect(argv).toContain('--share-net'); // the API has to be reachable
    expect(argv).toContain('--clearenv');
    expect(argv).toContain('--new-session');
    expect(argv).toContain('--die-with-parent');
    // A private /proc, so other processes' environments are not readable.
    expect(joined).toContain('--proc /proc');
    expect(argv.at(-1)).toBe('--');

    expect(joined).toContain(`--bind ${configDir}`);
    expect(joined).toContain(`--bind ${workDir}`);
    expect(joined).toContain(`--ro-bind ${project}`);
    expect(joined).toContain(`--setenv CLAUDE_CONFIG_DIR ${configDir}`);
    expect(joined).toContain(`--setenv HOME ${workDir}`);
  });

  it('never binds office data, /mnt, /init or the WSL interop socket', () => {
    const joined = buildSandboxArgv(spec()).join(' ');
    // The run's own two directories live under the data root, so the check is
    // on the private paths themselves, not on their parent.
    for (const forbidden of [
      path.join(dataRoot, 'agents'),
      path.join(dataRoot, 'blobs'),
      path.join(dataRoot, 'agent-office.db'),
      '/mnt',
      '/init',
      '/run/WSL',
    ]) {
      expect(joined).not.toContain(` ${forbidden}`);
    }
  });

  it('passes no ambient environment beyond the allowlist', () => {
    const previous = { ...process.env };
    process.env['ANTHROPIC_API_KEY'] = 'should-not-travel';
    process.env['PIXEL_AGENTS_TOKEN'] = 'should-not-travel';
    try {
      const inherited = inheritedEnv();
      expect(Object.keys(inherited).every((key) => INHERITED_ENV_KEYS.includes(key))).toBe(true);
      const joined = buildSandboxArgv({ ...spec(), env: inherited }).join(' ');
      expect(joined).not.toContain('should-not-travel');
      expect(joined).not.toContain('ANTHROPIC_API_KEY');
    } finally {
      process.env = previous;
    }
  });
});

describe.skipIf(!bwrapAvailable)('inside a real bubblewrap namespace', () => {
  function inside(script: string): { stdout: string; status: number } {
    const argv = [...buildSandboxArgv(spec()), '/bin/sh', '-c', script];
    const result = spawnSync('bwrap', argv, { encoding: 'utf8', env: { SECRET: 'parent-secret' } });
    return { stdout: `${result.stdout}${result.stderr}`, status: result.status ?? -1 };
  }

  it('cannot see the agent files at all', () => {
    // Not "refused": the path does not exist in this namespace.
    const { stdout } = inside(`cat ${path.join(dataRoot, 'agents', 'instructions.md')} 2>&1`);
    expect(stdout).toMatch(/No such file or directory/);
    expect(stdout).not.toContain('AGENT SECRET');
    // And the file outside is untouched.
    expect(fs.readFileSync(path.join(dataRoot, 'agents', 'instructions.md'), 'utf8')).toBe(
      'AGENT SECRET',
    );
  });

  it('reads the project but cannot write to it', () => {
    const read = inside(`cat ${path.join(project, 'README.md')}`);
    expect(read.stdout).toContain('PROJECT CONTENT');

    const write = inside(`echo tampered > ${path.join(project, 'README.md')} 2>&1`);
    expect(write.status).not.toBe(0);
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('PROJECT CONTENT');
  });

  it('writes only to its own working directory', () => {
    const { status } = inside(`echo output > ${path.join(workDir, 'result.md')}`);
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(workDir, 'result.md'), 'utf8')).toBe('output\n');
  });

  it('inherits none of the parent environment and sees no other processes', () => {
    const { stdout } = inside('echo "SECRET=[$SECRET]"; ls /proc | grep -c "^[0-9]*$"');
    expect(stdout).toContain('SECRET=[]');
    // Its own pid namespace: a handful of entries, not the host's process list.
    const pids = Number(stdout.trim().split('\n').at(-1));
    expect(pids).toBeLessThan(10);
  });

  it('has no interpreter for a Windows executable to reach', () => {
    // WSL interop works through /init as the binfmt handler. It is not bound,
    // so there is nothing for a .exe to be handed to. This is the reasoning the
    // WSL verification checks on a real host; here it only shows /init is absent.
    const { stdout } = inside('ls /init /mnt /run/WSL 2>&1');
    expect(stdout).not.toMatch(/^\/init$/m);
    expect(stdout).toMatch(/No such file or directory/);
  });
});

describe('bubblewrap availability', () => {
  it('is reported honestly', () => {
    // This suite proves nothing about WSL2; it runs on this Linux host only.
    if (!bwrapAvailable) {
      expect(() => execFileSync('bwrap', ['--version'])).toThrow();
    } else {
      expect(execFileSync('bwrap', ['--version'], { encoding: 'utf8' })).toContain('bubblewrap');
    }
  });
});

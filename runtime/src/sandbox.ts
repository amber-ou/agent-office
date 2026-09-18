/**
 * OS-level isolation for one Claude Code run.
 *
 * The runtime executes shell commands on the operator's behalf, so telling it
 * not to touch the Agent's own files is not a control — a deny rule applies to
 * Claude's file tools and nothing else, and `Bash` runs with this process's
 * permissions. The control is that the paths are not in the process's mount
 * namespace at all.
 *
 * bubblewrap builds that namespace: an empty root with only what the run needs
 * bound into it. `~/.agent-office`, `~/.pixel-agents` and `~/.claude` are
 * simply absent, so reading them fails with ENOENT rather than being refused by
 * a policy someone can talk their way around.
 *
 * What this does NOT do, and must not be described as doing:
 *  - **The network is shared.** The run reaches the internet (it has to, to
 *    talk to the API) and every service on this host. Nothing here prevents
 *    exfiltration.
 *  - **A credential the run authenticates with is readable by the run.** It is
 *    passed in the environment rather than a file, which keeps it out of the
 *    command line and out of any config the sandbox can persist — but the
 *    process can read its own environment and write it anywhere it can write.
 *  - **WSL interop is handled by omission, not by a switch.** `/init`,
 *    `/run/WSL` and `/mnt` are never bound, and the interop variables are not
 *    passed, so `binfmt_misc` has no interpreter to reach. That reasoning is
 *    sound on paper and is UNVERIFIED on a real WSL2 host.
 */

import * as path from 'node:path';

/** Everything one sandboxed run may see. Nothing else exists inside it. */
export interface SandboxSpec {
  /** Read-write. `CLAUDE_CONFIG_DIR` — this run's own Claude configuration. */
  configDir: string;
  /** Read-write. The run's working directory, and its only writable output. */
  workDir: string;
  /** Read-only. Project directories the task may read. */
  readOnlyPaths: readonly string[];
  /** Read-only system paths. Defaults cover a normal Linux userland. */
  systemPaths?: readonly string[];
  /** Extra environment for the child, on top of the allowlist below. */
  env?: Readonly<Record<string, string>>;
}

/**
 * The only environment variables a run inherits.
 *
 * An allowlist, not a denylist: the Office process's environment holds the
 * server's own bearer token and whatever else the operator exported, and none
 * of that is the run's business. `ANTHROPIC_API_KEY` is deliberately absent —
 * a run must not silently switch to a different credential or billing route.
 */
export const INHERITED_ENV_KEYS: readonly string[] = ['LANG', 'LC_ALL', 'TZ'];

const DEFAULT_SYSTEM_PATHS: readonly string[] = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

/**
 * Paths a sandbox must never bind, whatever a project's settings say.
 *
 * Checked against the RESOLVED path, so a symlink, a `..` or a differently
 * spelled alias lands on the same answer.
 */
export interface ForbiddenRoots {
  /** `~/.agent-office` — the database, the blobs and every agent's files. */
  officeDataRoot: string;
  /** Anything else private to this machine's Office install. */
  others?: readonly string[];
}

export class SandboxPathError extends Error {}

/**
 * Validate one path a run wants bound, and return the resolved path to bind.
 *
 * `resolve` is injected so this stays pure and testable; callers pass
 * `fs.realpathSync`.
 */
export function resolveBindPath(
  candidate: string,
  forbidden: ForbiddenRoots,
  resolve: (p: string) => string,
): string {
  let resolved: string;
  try {
    resolved = resolve(candidate);
  } catch {
    throw new SandboxPathError(`workspace path does not exist: ${candidate}`);
  }
  if (!path.isAbsolute(resolved)) {
    throw new SandboxPathError(`workspace path is not absolute: ${candidate}`);
  }
  if (resolved === path.parse(resolved).root) {
    throw new SandboxPathError('refusing to bind the filesystem root as a workspace');
  }

  const roots = [forbidden.officeDataRoot, ...(forbidden.others ?? [])].map((root) => {
    try {
      return resolve(root);
    } catch {
      return path.resolve(root);
    }
  });
  for (const root of roots) {
    // Equal, inside, or an ancestor of: all three would put Office's own data
    // into the run's namespace.
    if (resolved === root || isInside(resolved, root) || isInside(root, resolved)) {
      throw new SandboxPathError(
        `workspace path ${candidate} resolves to ${resolved}, which overlaps Agent Office's private data at ${root}`,
      );
    }
  }
  return resolved;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * The bubblewrap arguments for one run, ending with `--` so the caller appends
 * the command to execute.
 *
 * `--unshare-all` gives new user, pid, ipc, uts, cgroup and mount namespaces,
 * and `--share-net` hands the network back, because the run has to reach the
 * API. `--new-session` detaches the controlling terminal so the child cannot
 * push input back into ours; `--die-with-parent` means a stopped Office takes
 * its runs with it.
 */
export function buildSandboxArgv(spec: SandboxSpec): string[] {
  const args = [
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    // Nothing of ours leaks in; every variable below is put there on purpose.
    '--clearenv',
    // A private /proc, so the run cannot read other processes' environments.
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];

  for (const systemPath of spec.systemPaths ?? DEFAULT_SYSTEM_PATHS) {
    // Missing on some distributions (/lib64, /sbin); bind only what exists.
    args.push('--ro-bind-try', systemPath, systemPath);
  }

  // The run's own two writable directories, at their real paths so tool output
  // and transcripts refer to somewhere that exists outside too.
  args.push('--bind', spec.configDir, spec.configDir);
  args.push('--bind', spec.workDir, spec.workDir);
  for (const readOnly of spec.readOnlyPaths) {
    args.push('--ro-bind', readOnly, readOnly);
  }

  // HOME is the run's own directory: a tool that writes to `~` writes here.
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: spec.workDir,
    CLAUDE_CONFIG_DIR: spec.configDir,
    ...spec.env,
  };
  for (const [key, value] of Object.entries(env)) {
    args.push('--setenv', key, value);
  }

  args.push('--chdir', spec.workDir, '--');
  return args;
}

/** Pick up the few ambient variables a run legitimately needs. */
export function inheritedEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = from[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

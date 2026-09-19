/**
 * The Claude Code runtime bridge — one Task, one `claude` process.
 *
 * Upstream's hook channel is OBSERVATIONAL and one-way: hooks report what a
 * Claude session did, and there is no way to ask one to do anything. Upstream's
 * only command path is a VS Code terminal that `sendText`s `claude` into a TTY,
 * which gives no captured result and does not exist in the standalone server.
 * So the command channel is this: Claude Code's own non-interactive mode, run
 * as a child process, prompt on stdin, result as JSON on stdout (ADR 003 — the
 * downward channel is never folded into `AgentEvent`).
 *
 *   claude -p --output-format json --session-id <uuid> [--model <id>]
 *
 * A revision continues that same conversation with Claude Code's own resume:
 *
 *   claude -p --output-format json --resume <uuid> [--model <id>]
 *
 * which keeps the earlier turns on Claude's side, so the feedback is all that
 * has to be sent. `--resume` replaces `--session-id`: the run joins the session
 * it names rather than opening a new one.
 *
 * The Office session id IS the `--session-id`, so the run's transcript, its
 * hooks and its Office record all agree on one identifier without a mapping
 * table. Hook events, if hooks are installed, keep flowing into the pixel office
 * exactly as before — observation, unchanged and still separate.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import type { ContextBudget, SessionId } from '../../domain/src/index.js';
import { defaultContextBudget } from '../../domain/src/index.js';
import type {
  AgentRuntimeAdapter,
  RuntimeDescriptor,
  RuntimeHealth,
  StartRunRequest,
  StartRunResult,
} from './adapter.js';
import { RuntimeKind } from './adapter.js';
import type { ContentsById } from './promptRenderer.js';
import { renderPrompt } from './promptRenderer.js';
import type { SandboxSpec } from './sandbox.js';
import { buildSandboxArgv } from './sandbox.js';

/** The subset of `child_process.spawn` this adapter uses. Injectable for tests. */
export type SpawnLike = typeof nodeSpawn;

/**
 * `StartRunRequest` plus the blob text the prompt needs.
 *
 * The seam in `adapter.ts` carries a bundle of records, not their content, and
 * a runtime owns no storage — so the caller that DID read the blobs passes them
 * alongside. Optional, so the adapter interface is satisfied unchanged.
 */
export interface ClaudeStartRunRequest extends StartRunRequest {
  contents?: ContentsById;
  /**
   * Continue this provider session instead of opening a new one. The earlier
   * turns stay on Claude's side, so `prompt` carries only what is new.
   */
  resume?: string;
  /** Send this text instead of rendering the bundle. Used by a revision. */
  prompt?: string;
  /**
   * Directories this run may not read or write through Claude's file tools.
   * Per-run rather than per-runtime, so the caller that knows where the agent
   * files live decides, whoever constructed the runtime.
   *
   * A second line of defence only: these rules bind Claude's own file tools,
   * not `Bash`. The sandbox below is what actually removes the paths.
   */
  denyPaths?: readonly string[];
  /**
   * Run inside an OS sandbox. When set, `claude` is executed through
   * bubblewrap with the namespace this describes, and the child inherits no
   * environment beyond what the spec names.
   */
  sandbox?: SandboxSpec;
  /**
   * Run as this Claude Code subagent for the whole session: `claude --agent
   * <name>`. CC replaces its default system prompt, tool restrictions and
   * model with the named subagent's own — read from ITS file, not from
   * anything Office sends — so `request.agent.model` is not also passed as
   * `--model`: `--agent` already sets it, and passing both would contest the
   * same setting. The caller is expected to have already rendered `prompt`
   * (e.g. via `renderNativeAgentPrompt`) without an Office-assembled persona
   * section, since CC is about to load its own.
   */
  nativeAgent?: string;
}

export interface ClaudeRunOutcome {
  sessionId: SessionId;
  ok: boolean;
  /** The run's final text. Present on success, and on failure when there is any. */
  result: string;
  /** Why it failed. Absent on success. */
  error?: string;
  /** Claude's own session id, as reported. Usually the one we passed in. */
  providerSessionId?: string;
}

export interface ClaudeCliRuntimeOptions {
  /**
   * Directories a run must not read or write through Claude's file tools —
   * the Agent Office data root, above all. Passed to `claude --settings` as
   * deny rules, which the CLI enforces itself.
   *
   * Absolute paths take Claude's `//` prefix inside a rule; that is done here
   * so callers pass ordinary paths.
   */
  denyPaths?: readonly string[];
  /** Executable name or path. Default `claude`. */
  command?: string;
  /** The sandbox launcher. Default `bwrap`. */
  sandboxCommand?: string;
  spawn?: SpawnLike;
  /** Extra arguments, e.g. a sandbox flag. Appended after ours. */
  extraArgs?: readonly string[];
  /** Hard ceiling on one run. Default 30 minutes. */
  timeoutMs?: number;
  /** Fallback content resolver, for callers that pass no `contents`. */
  contentsFor?: (request: StartRunRequest) => Promise<ContentsById>;
  /**
   * Character ceiling for the rendered prompt. The bundle carries the items the
   * selector already chose but not the budget it chose them under, so the one
   * the renderer enforces is set here.
   */
  budget?: ContextBudget;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

interface LiveRun {
  kill(): void;
}

/**
 * `startRun` resolves as soon as the process is up; the run's completion arrives
 * through `onOutcome`. That split is deliberate: `AgentRuntimeAdapter` says
 * nothing about results, and a long run must not be an unresolved promise held
 * across a websocket message.
 */
export class ClaudeCliRuntime implements AgentRuntimeAdapter {
  readonly descriptor: RuntimeDescriptor = {
    id: 'claude-cli',
    kind: RuntimeKind.LOCAL_CLI,
    providers: ['claude'],
    projects: [],
  };

  private readonly command: string;
  private readonly sandboxCommand: string;
  private readonly spawn: SpawnLike;
  private readonly extraArgs: readonly string[];
  private readonly timeoutMs: number;
  private readonly contentsFor: (request: StartRunRequest) => Promise<ContentsById>;
  private readonly budget: ContextBudget;
  private readonly denyPaths: readonly string[];
  private readonly live = new Map<SessionId, LiveRun>();
  private readonly listeners = new Set<(outcome: ClaudeRunOutcome) => void>();

  constructor(options: ClaudeCliRuntimeOptions = {}) {
    this.command = options.command ?? 'claude';
    this.sandboxCommand = options.sandboxCommand ?? 'bwrap';
    this.spawn = options.spawn ?? nodeSpawn;
    this.extraArgs = options.extraArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.contentsFor = options.contentsFor ?? (async () => new Map());
    this.budget = options.budget ?? defaultContextBudget();
    this.denyPaths = options.denyPaths ?? [];
  }

  /** Subscribe to run outcomes. Returns the unsubscribe. */
  onOutcome(listener: (outcome: ClaudeRunOutcome) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startRun(request: ClaudeStartRunRequest): Promise<StartRunResult> {
    if (this.live.has(request.sessionId)) {
      throw new Error(`session already running: ${request.sessionId}`);
    }
    let prompt = request.prompt;
    if (prompt === undefined) {
      const contents = request.contents ?? (await this.contentsFor(request));
      prompt = renderPrompt(request.context, contents, this.budget).text;
    }

    const args = [
      '-p',
      '--output-format',
      'json',
      // Resuming names an existing session; starting names the new one. Passing
      // both would be asking for two different sessions at once.
      ...(request.resume ? ['--resume', request.resume] : ['--session-id', request.sessionId]),
      // --agent replaces the default system prompt/tools/model with the named
      // subagent's own, so --model would contest a setting --agent already
      // makes — the two are mutually exclusive here, never both passed.
      ...(request.nativeAgent
        ? ['--agent', request.nativeAgent]
        : request.agent.model
          ? ['--model', request.agent.model]
          : []),
      ...denySettingsArgs(request.denyPaths ?? this.denyPaths),
      ...this.extraArgs,
    ];

    // Sandboxed runs go through bubblewrap; `env` is handed over by the spec,
    // never inherited, so the Office's own secrets stay out of the child.
    const sandbox = request.sandbox;
    const launch = sandbox
      ? {
          command: this.sandboxCommand,
          argv: [...buildSandboxArgv(sandbox), this.command, ...args],
        }
      : windowsSafeLaunch(this.command, args);

    const child = this.spawn(launch.command, launch.argv, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // bwrap sets the child's own environment with --setenv; passing ours
      // through as well would defeat the point.
      ...(sandbox ? { env: {} } : {}),
      ...('verbatim' in launch && launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      // A hung run is a failure with a reason, not a process left behind.
      child.kill('SIGTERM');
    }, this.timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const finish = (outcome: ClaudeRunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      this.live.delete(request.sessionId);
      this.emit(outcome);
    };

    child.on('error', (error: Error) => {
      // The executable is missing, or could not be spawned at all.
      finish({
        sessionId: request.sessionId,
        ok: false,
        result: '',
        error: `could not start ${launch.command}: ${error.message}`,
      });
    });

    child.on('close', (code: number | null) => {
      finish(parseOutcome(request.sessionId, code, stdout, stderr));
    });

    // The prompt goes in on stdin: it can be tens of thousands of characters,
    // which is past what an argument list reliably carries, and stdin needs no
    // shell quoting.
    child.stdin?.end(prompt);

    this.live.set(request.sessionId, { kill: () => child.kill('SIGTERM') });
    return { providerSessionId: request.resume ?? request.sessionId };
  }

  /**
   * Not supported in this phase. `claude -p` is a single non-interactive turn;
   * talking into a live run needs a different mode, and this phase is one task,
   * one run.
   */
  async sendMessage(): Promise<void> {
    throw new Error('sendMessage is not supported by the Claude CLI runtime in this phase');
  }

  async stopRun(sessionId: SessionId): Promise<void> {
    this.live.get(sessionId)?.kill();
  }

  /**
   * Is the sandbox usable on this machine?
   *
   * Asked before every dispatch and answered by actually entering a namespace:
   * bubblewrap can be installed and still be refused (an unprivileged user
   * namespace disabled by policy), and a run must not start when it is.
   */
  async probeSandbox(): Promise<RuntimeHealth> {
    return new Promise((resolve) => {
      const child = this.spawn(
        this.sandboxCommand,
        [
          '--unshare-all',
          '--share-net',
          // Enough of a userland for the probe's own command to exist. Binding
          // only /usr leaves /bin missing on a system where it is a symlink,
          // and the probe then fails for a reason that has nothing to do with
          // whether a namespace can be created.
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
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error: Error) =>
        resolve({ ok: false, detail: `${this.sandboxCommand}: ${error.message}` }),
      );
      child.on('close', (code: number | null) =>
        resolve(
          code === 0
            ? { ok: true }
            : { ok: false, detail: stderr.trim() || `${this.sandboxCommand} exited ${code}` },
        ),
      );
    });
  }

  async health(): Promise<RuntimeHealth> {
    return new Promise((resolve) => {
      const child = this.spawn(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let version = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        version += chunk.toString();
      });
      child.on('error', (error: Error) => resolve({ ok: false, detail: error.message }));
      child.on('close', (code: number | null) =>
        resolve(
          code === 0
            ? { ok: true, detail: version.trim() }
            : { ok: false, detail: `${this.command} --version exited ${code}` },
        ),
      );
    });
  }

  private emit(outcome: ClaudeRunOutcome): void {
    for (const listener of this.listeners) {
      listener(outcome);
    }
  }
}

/**
 * Launching on Windows, where `claude` is a `.cmd` shim.
 *
 * Node refuses to spawn a `.cmd` directly, and `shell: true` would hand our
 * arguments — one of which is a JSON document — to cmd.exe's own quoting
 * rules. So the command line is built and quoted here and passed verbatim.
 *
 * UNVERIFIED: no Windows host was available to run this on.
 */
function windowsSafeLaunch(
  command: string,
  args: readonly string[],
): { command: string; argv: string[]; verbatim?: true } {
  if (process.platform !== 'win32') {
    return { command, argv: [...args] };
  }
  const line = [command, ...args].map(quoteForCmd).join(' ');
  return {
    command: process.env['COMSPEC'] ?? 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Deny rules for the paths a run has no business touching.
 *
 * Claude Code enforces these for its own file tools (Read, Write, Edit and the
 * notebook variants) — proven against the real CLI, not assumed. `Bash` is NOT
 * covered: a shell command runs as the same user and can reach any path this
 * process can, so this narrows the blast radius rather than sealing it. See
 * ADR 007.
 */
function denySettingsArgs(denyPaths: readonly string[]): string[] {
  if (denyPaths.length === 0) {
    return [];
  }
  const deny = denyPaths.flatMap((dir) => {
    // A rule's absolute path is written with a leading `//` in Claude's
    // permission syntax; a single slash silently matches nothing.
    const pattern = `//${dir.replace(/^\/+/, '')}/**`;
    return [
      `Read(${pattern})`,
      `Write(${pattern})`,
      `Edit(${pattern})`,
      `NotebookEdit(${pattern})`,
    ];
  });
  return ['--settings', JSON.stringify({ permissions: { deny } })];
}

/** Claude's JSON result envelope, as far as this bridge reads it. */
interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

function parseOutcome(
  sessionId: SessionId,
  code: number | null,
  stdout: string,
  stderr: string,
): ClaudeRunOutcome {
  let envelope: ClaudeResultEnvelope | null = null;
  try {
    envelope = JSON.parse(stdout.trim()) as ClaudeResultEnvelope;
  } catch {
    envelope = null;
  }

  if (code !== 0 || !envelope) {
    // Never swallowed: whatever the runtime said is what the failure carries.
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(-2000);
    return {
      sessionId,
      ok: false,
      result: '',
      error: detail || `${'claude'} exited with code ${code}`,
    };
  }

  const result = typeof envelope.result === 'string' ? envelope.result : '';
  if (envelope.is_error) {
    return {
      sessionId,
      ok: false,
      result,
      error: result || `run reported an error (${envelope.subtype ?? 'unknown'})`,
      ...(envelope.session_id ? { providerSessionId: envelope.session_id } : {}),
    };
  }
  return {
    sessionId,
    ok: true,
    result,
    ...(envelope.session_id ? { providerSessionId: envelope.session_id } : {}),
  };
}

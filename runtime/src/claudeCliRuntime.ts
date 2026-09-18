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
  /** Executable name or path. Default `claude`. */
  command?: string;
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
  private readonly spawn: SpawnLike;
  private readonly extraArgs: readonly string[];
  private readonly timeoutMs: number;
  private readonly contentsFor: (request: StartRunRequest) => Promise<ContentsById>;
  private readonly budget: ContextBudget;
  private readonly live = new Map<SessionId, LiveRun>();
  private readonly listeners = new Set<(outcome: ClaudeRunOutcome) => void>();

  constructor(options: ClaudeCliRuntimeOptions = {}) {
    this.command = options.command ?? 'claude';
    this.spawn = options.spawn ?? nodeSpawn;
    this.extraArgs = options.extraArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.contentsFor = options.contentsFor ?? (async () => new Map());
    this.budget = options.budget ?? defaultContextBudget();
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
      ...(request.agent.model ? ['--model', request.agent.model] : []),
      ...this.extraArgs,
    ];

    const child = this.spawn(this.command, args, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
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
        error: `could not start ${this.command}: ${error.message}`,
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

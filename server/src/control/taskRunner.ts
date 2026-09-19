/**
 * One task, one Claude Code run.
 *
 * The Control Plane's half of the bridge: eligibility, the AgentSession record,
 * context assembly, dispatch, and what to persist when the run comes back. The
 * runtime half — actually starting `claude` — is `runtime/`, reached only
 * through `AgentRuntimeAdapter` (ADR 003).
 *
 * V1 runs ONE task at a time, process-wide. Anything else is orchestration, and
 * orchestration is a later milestone.
 *
 * What a run may write: the AgentSession, the Task's status and outputs, and an
 * OutputItem with its blob. What it may never write: the AgentDefinition, its
 * Skills, its AgentKnowledge. A run produces a deliverable, not a memory.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AgentDefinition,
  AgentId,
  AgentSession,
  OutputItem,
  Project,
  Repositories,
  SessionId,
  Task,
  TaskId,
} from '../../../domain/src/index.js';
import {
  asTaskId,
  attachOutput,
  bindExternalRuntime,
  canTransitionTask,
  createOutputItem,
  isLiveSession,
  startSession,
  systemClock,
  transitionSession,
  transitionTask,
  uuidIdGenerator,
} from '../../../domain/src/index.js';
import type {
  ClaudeRunOutcome,
  ClaudeStartRunRequest,
  SandboxSpec,
} from '../../../runtime/src/index.js';
import {
  ClaudeCliRuntime,
  inheritedEnv,
  renderNativeAgentPrompt,
  resolveBindPath,
} from '../../../runtime/src/index.js';
import type { ReviewNote } from '../../../storage/src/index.js';
import { parseNativeAgentFile, verifyNativeAgentDiscoverable } from '../../../storage/src/index.js';
import { assembleContext } from './contextAssembly.js';
import type { OfficeStorage } from './officeStorage.js';
import type { RunMode } from './runMode.js';
import { decideRunMode, readWindowsConsent } from './runMode.js';

const DEPS = { ids: uuidIdGenerator, clock: systemClock };

/**
 * The credential a sandboxed run authenticates with.
 *
 * A sandbox has no `~/.claude`, so an interactive login on this machine is not
 * reachable from inside it. Only the OAuth token is read: an API key would be a
 * different credential and a different billing route, and switching one for the
 * other silently is not this code's decision to make.
 */
function runCredential(): string | undefined {
  const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  return token && token.trim() ? token : undefined;
}

export interface RunStartedResult {
  sessionId: SessionId;
  taskId: TaskId;
}

/** What the UI is told as a run moves. `session` is the persisted record. */
export interface RunChange {
  taskId: TaskId;
  session: AgentSession;
}

/**
 * The Claude runtime this process dispatches to.
 *
 * A module singleton, because a run outlives the message that started it and
 * every surface shares the one executor. Tests replace it with a fake adapter;
 * the production path never does (`setTaskRuntime` is the only seam, and the
 * default is the real CLI).
 */
let runtime: ClaudeCliRuntime | undefined;

export function getTaskRuntime(): ClaudeCliRuntime {
  runtime ??= new ClaudeCliRuntime();
  return runtime;
}

/** Test seam. Passing undefined restores the real Claude CLI runtime. */
export function setTaskRuntime(next: ClaudeCliRuntime | undefined): void {
  runtime = next;
}

export class TaskRunner extends EventEmitter {
  /** The one live run, or undefined. */
  private live: { sessionId: SessionId; taskId: TaskId } | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly storage: OfficeStorage) {
    super();
  }

  private get repos(): Repositories {
    return this.storage.repos;
  }

  private runtime(): ClaudeCliRuntime {
    return getTaskRuntime();
  }

  liveRun(): { sessionId: SessionId; taskId: TaskId } | undefined {
    return this.live;
  }

  /**
   * Dispatch one task.
   *
   * Every gate is checked before anything is written, so a refused dispatch
   * leaves the task exactly as it was.
   */
  async run(taskIdRaw: string, activeProjectId: string | undefined): Promise<RunStartedResult> {
    const { task, agent, dependencies, mode, nativeAgent } = await this.eligible(
      taskIdRaw,
      activeProjectId,
    );
    const { bundle, contents } = await assembleContext(this.storage, task);
    return this.dispatch({
      task,
      agent,
      dependencies,
      mode,
      nativeAgent,
      request: nativeAgent
        ? // CC is about to load this agent's own persona via --agent; sending
          // it again as an Office-assembled section would be a second, and
          // possibly contradictory, copy on top of it.
          { context: bundle, prompt: renderNativeAgentPrompt(bundle) }
        : { context: bundle, contents },
    });
  }

  /**
   * Continue the work after a human asked for changes.
   *
   * The feedback is recorded as a review note and the revision resumes the
   * SAME Claude session, so the earlier turns are already there and only the
   * new instruction is sent. The Office side of it is a NEW AgentSession over
   * the same `providerSessionId` — which the domain explicitly allows to repeat
   * across runs (ADR 002) — so the history keeps every run instead of
   * overwriting one.
   */
  async revise(
    taskIdRaw: string,
    feedback: string,
    activeProjectId: string | undefined,
  ): Promise<RunStartedResult> {
    const body = feedback.trim();
    if (!body) {
      throw new Error('review feedback must not be empty');
    }
    const { task, agent, dependencies, mode, nativeAgent } = await this.eligible(
      taskIdRaw,
      activeProjectId,
    );
    if (task.status !== 'review') {
      throw new Error(`only a task in review can be revised (this one is "${task.status}")`);
    }

    // The newest finished run for this task BY THIS AGENT is the conversation
    // to continue. A task reassigned to someone else starts fresh: the previous
    // agent's conversation is its own material, not something the next agent
    // inherits — and under the sandbox it cannot even see that transcript.
    const previous = (await this.repos.sessions.listByProject(task.projectId))
      .filter(
        (s) => s.taskId === task.id && s.agentId === task.assignedAgentId && s.providerSessionId,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

    const { bundle, contents } = await assembleContext(this.storage, task);
    const note: ReviewNote = {
      id: DEPS.ids.next(),
      taskId: task.id,
      ...(previous ? { aboutSessionId: previous.id } : {}),
      author: 'human',
      body,
      createdAt: DEPS.clock.now(),
    };

    return this.dispatch({
      task,
      agent,
      dependencies,
      mode,
      note,
      nativeAgent,
      request: {
        context: bundle,
        ...(nativeAgent ? {} : { contents }),
        ...(previous?.providerSessionId
          ? {
              resume: previous.providerSessionId,
              // Resumed: Claude still holds the task, the context and its own
              // last answer, so re-sending them would only cost tokens.
              prompt: revisionPrompt(body),
            }
          : nativeAgent
            ? { prompt: renderNativeAgentPrompt(bundle) }
            : {}),
      },
    });
  }

  /** The gates every dispatch passes, in the order whose refusal reads best. */
  private async eligible(
    taskIdRaw: string,
    activeProjectId: string | undefined,
  ): Promise<{
    task: Task;
    agent: AgentDefinition;
    dependencies: Task[];
    mode: RunMode;
    /** CC's own `name` for the agent, present only when this agent is linked
     *  to a native Claude Code subagent file (see `linkNativeAgent.ts`). Read
     *  fresh from that file right here, never from a cached copy, so a
     *  dispatch always uses whatever the file currently says. */
    nativeAgent?: string;
  }> {
    if (this.live) {
      throw new Error('another task is already running');
    }
    const task = await this.repos.tasks.get(asTaskId(taskIdRaw));
    if (!task) {
      throw new Error(`task not found: ${taskIdRaw}`);
    }
    if (activeProjectId !== undefined && task.projectId !== activeProjectId) {
      throw new Error('task does not belong to the active project');
    }
    if (task.assignedAgentId === undefined) {
      throw new Error('task has no assigned agent');
    }
    if (!(await this.repos.projectAgents.find(task.projectId, task.assignedAgentId))) {
      throw new Error('assigned agent is not a member of this project');
    }
    if (!canTransitionTask(task.status, 'in_progress')) {
      throw new Error(`a task in status "${task.status}" cannot start`);
    }
    // The same rule the domain enforces on the transition, checked up front so
    // the refusal names the real reason rather than failing mid-dispatch.
    const dependencies = await this.repos.tasks.listDependencies(task.id);
    const unmet = dependencies.filter((d) => d.status !== 'done');
    if (unmet.length > 0) {
      throw new Error(`${unmet.length} unmet dependenc${unmet.length === 1 ? 'y' : 'ies'}`);
    }
    const agent = await this.repos.agents.get(task.assignedAgentId);
    if (!agent) {
      throw new Error(`agent not found: ${task.assignedAgentId}`);
    }

    // Fail closed on the platforms that sandbox: no namespace, no run. On
    // Windows there is no namespace to fail, so the operator accepts the risk
    // once instead — see runMode.ts.
    const sandbox =
      process.platform === 'win32' ? { ok: false } : await this.runtime().probeSandbox();
    const decision = decideRunMode({
      platform: process.platform,
      windowsConsent: readWindowsConsent(this.storage.dataRoot),
      sandboxOk: sandbox.ok,
      ...(sandbox.detail === undefined ? {} : { sandboxDetail: sandbox.detail }),
      hasToken: runCredential() !== undefined,
    });
    if (decision.refusal) {
      throw new Error(decision.refusal);
    }

    const officeMeta = await this.storage.agentFiles.readOfficeMeta(agent.id);
    const nativeAgentPath = officeMeta?.nativeAgentPath;
    if (nativeAgentPath === undefined) {
      return { task, agent, dependencies, mode: decision.mode };
    }
    // A native-linked agent has no discovery/agent.md of its own (see
    // linkNativeAgent.ts) — its file IS the run, so it is read fresh here,
    // at dispatch time, rather than trusting whatever name/tools the
    // database cached when it was last linked or refreshed.
    if (decision.mode === 'sandboxed') {
      throw new Error(
        `agent "${agent.name}" is linked to a native Claude Code agent file, which a sandboxed run cannot reach: ` +
          '~/.claude is deliberately outside the sandbox namespace (see ADR 007). Dispatch this task from an ' +
          'unsandboxed (Windows shell-mode) run for now.',
      );
    }
    let nativeText: string;
    try {
      nativeText = fs.readFileSync(nativeAgentPath, 'utf8');
    } catch (error) {
      throw new Error(
        `agent "${agent.name}" is linked to ${nativeAgentPath}, which could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = parseNativeAgentFile(nativeText);
    if (!parsed.ok) {
      throw new Error(`agent "${agent.name}"'s native file ${nativeAgentPath}: ${parsed.reason}`);
    }
    // Same check `link-native-agent` runs up front, repeated here because the
    // file — or a sibling that now shares its name — can have changed since
    // the last link: a stale "yes, --agent will find it" is worse than
    // re-proving it on every dispatch.
    const discoverable = verifyNativeAgentDiscoverable(
      nativeAgentPath,
      parsed.agent.fields.name,
      this.storage.ccDiscoveryPaths.claudeAgentsRoot,
    );
    if (!discoverable.ok) {
      throw new Error(`agent "${agent.name}": ${discoverable.reason}`);
    }
    return {
      task,
      agent,
      dependencies,
      mode: decision.mode,
      nativeAgent: parsed.agent.fields.name,
    };
  }

  /**
   * The namespace one run sees: its own config and working directories, the
   * project read-only, and nothing else.
   *
   * Both directories are keyed by agent AND task, so no two agents and no two
   * tasks share a Claude configuration, a transcript or a workspace.
   */
  private sandboxFor(agentId: AgentId, taskId: TaskId, project: Project): SandboxSpec {
    const base = path.join(this.storage.runtimeRoot, agentId, taskId);
    const configDir = path.join(base, 'config');
    const workDir = path.join(base, 'work');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });

    const forbidden = {
      officeDataRoot: this.storage.dataRoot,
      others: [path.join(os.homedir(), '.pixel-agents'), path.join(os.homedir(), '.claude')],
    };
    const readOnlyPaths = project.settings.workspacePaths.map((candidate) =>
      // Resolved before binding: a symlink, a `..` or an alias that lands on
      // Office's own data is refused here rather than mounted.
      resolveBindPath(candidate, forbidden, (p) => fs.realpathSync(p)),
    );

    return {
      configDir,
      workDir,
      readOnlyPaths,
      env: {
        ...inheritedEnv(),
        // In the environment, never on the command line and never in a file the
        // run could keep. The run can still read its own environment and write
        // the token wherever it can write — that is not preventable here.
        CLAUDE_CODE_OAUTH_TOKEN: runCredential() ?? '',
      },
    };
  }

  /** Record the run, then hand it to the runtime. Shared by run and revise. */
  private async dispatch(input: {
    task: Task;
    agent: AgentDefinition;
    dependencies: Task[];
    mode: RunMode;
    note?: ReviewNote;
    nativeAgent?: string;
    request: Pick<ClaudeStartRunRequest, 'context' | 'contents' | 'resume' | 'prompt'>;
  }): Promise<RunStartedResult> {
    const { task, agent, dependencies, note, nativeAgent } = input;

    // The session is the run's identity in the Office, and its id is what the
    // provider is told to use — one identifier, no mapping table. A revision
    // carries the resumed session's provider id instead.
    const session = startSession(
      {
        agentId: agent.id,
        projectId: task.projectId,
        provider: agent.provider,
        taskId: task.id,
        runtimeId: this.runtime().descriptor.id,
        ...(input.request.resume ? { providerSessionId: input.request.resume } : {}),
      },
      DEPS,
    );
    const started = transitionTask(task, 'in_progress', DEPS.clock, {
      dependencyStatuses: dependencies.map((d) => d.status),
    });
    await this.storage.uow.run(async (repos) => {
      await repos.sessions.put(session);
      await repos.tasks.put(started);
      if (note) {
        // The note and the run it started commit together, or neither does.
        await this.storage.reviews.put({ ...note, triggeredSessionId: session.id });
      }
    });

    this.live = { sessionId: session.id, taskId: task.id };
    this.listen();
    this.emitChange(task.id, session);

    const sandbox = this.sandboxFor(agent.id, task.id, input.request.context.project);
    const request: ClaudeStartRunRequest = {
      sessionId: session.id,
      agent,
      context: input.request.context,
      // Fixed per TASK, not per run: Claude stores a session's transcript under
      // a key derived from the working directory, so a revision that moved
      // would be a revision that could not resume.
      cwd: sandbox.workDir,
      // The renderer needs the blob text; the runtime reads no storage itself.
      ...(input.request.contents ? { contents: input.request.contents } : {}),
      ...(input.request.resume ? { resume: input.request.resume } : {}),
      ...(input.request.prompt === undefined ? {} : { prompt: input.request.prompt }),
      ...(nativeAgent ? { nativeAgent } : {}),
      // A run may not reach any agent's own files through Claude's file tools.
      // The sandbox is what removes those paths; this is the second line.
      denyPaths: [this.storage.agentFiles.root],
      // Shell mode has no namespace to build. It also keeps the operator's own
      // Claude configuration, because that is where their login is and there is
      // nothing hiding it from the run — the cost is that runs on Windows share
      // one transcript store, which the notice they accepted says.
      ...(input.mode === 'sandboxed' ? { sandbox } : {}),
    };
    try {
      const result = await this.runtime().startRun(request);
      const running = transitionSession(
        bindExternalRuntime(session, {
          ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
          ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
        }),
        'running',
        DEPS.clock,
      );
      await this.repos.sessions.put(running);
      this.emitChange(task.id, running);
    } catch (error) {
      // Failing to start is a failed run, recorded like any other.
      await this.finish({
        sessionId: session.id,
        ok: false,
        result: '',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return { sessionId: session.id, taskId: task.id };
  }

  /** Stop the live run, if there is one. The outcome arrives as a failure. */
  async cancel(): Promise<void> {
    if (this.live) {
      await this.runtime().stopRun(this.live.sessionId);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private listen(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.runtime().onOutcome((outcome) => {
      void this.finish(outcome).catch((error: unknown) => {
        // Nothing above this to catch it, and a swallowed persistence failure
        // would leave a task stuck in progress with no explanation.
        console.error('[Agent Office] failed to record a run outcome:', error);
      });
    });
  }

  /**
   * Record what the run produced.
   *
   * Success: the final text becomes an OutputItem attached to the task, and the
   * task moves to REVIEW — a machine deciding its own work is finished is not
   * something this phase does. Failure: the task moves to FAILED, which the
   * domain allows to be re-queued, and the reason is kept on the session.
   */
  private async finish(outcome: ClaudeRunOutcome): Promise<void> {
    if (this.live?.sessionId !== outcome.sessionId) {
      return;
    }
    const { taskId } = this.live;
    this.live = undefined;
    this.dispose();

    const session = await this.repos.sessions.get(outcome.sessionId);
    const task = await this.repos.tasks.get(taskId);
    if (!session || !task || !isLiveSession(session.status)) {
      return;
    }

    const finished = await this.storage.uow.run(async (repos) => {
      if (!outcome.ok) {
        const failed = transitionSession(session, 'failed', DEPS.clock, {
          error: outcome.error ?? 'run failed',
        });
        await repos.sessions.put(failed);
        // A task that failed is retryable: the domain allows failed → todo.
        await repos.tasks.put(transitionTask(task, 'failed', DEPS.clock));
        return failed;
      }

      const output = await this.persistOutput(repos, task, session, outcome.result);
      await repos.tasks.put(
        transitionTask(attachOutput(task, output.id, DEPS.clock), 'review', DEPS.clock),
      );
      const ended = transitionSession(session, 'ended', DEPS.clock);
      await repos.sessions.put(ended);
      return ended;
    });

    this.emitChange(taskId, finished);
  }

  private async persistOutput(
    repos: Repositories,
    task: Task,
    session: AgentSession,
    result: string,
  ): Promise<OutputItem> {
    const location = await repos.blobs.write(
      { owner: { kind: 'project', projectId: task.projectId }, name: `${task.title}.md` },
      result,
    );
    const output = createOutputItem(
      {
        projectId: task.projectId,
        taskId: task.id,
        producedByAgentId: session.agentId,
        sessionId: session.id,
        title: task.title,
        type: 'markdown',
        location,
      },
      DEPS,
    );
    await repos.outputs.put(output);
    return output;
  }

  private emitChange(taskId: TaskId, session: AgentSession): void {
    const change: RunChange = { taskId, session };
    this.emit('change', change);
  }
}

/**
 * One runner per process, bound to the open database.
 *
 * Keyed by the database path, NOT by the storage object: `getOfficeStorage()`
 * hands out a fresh wrapper on every call, so comparing identity would build a
 * new runner for every message and lose the run in flight.
 */
let instance: { key: string; runner: TaskRunner } | undefined;

export function getTaskRunner(storage: OfficeStorage): TaskRunner {
  if (instance?.key !== storage.databasePath) {
    instance?.runner.dispose();
    instance = { key: storage.databasePath, runner: new TaskRunner(storage) };
  }
  return instance.runner;
}

/**
 * What a resumed run is sent.
 *
 * Short on purpose: Claude still holds the task, the project context, the
 * agent's own material and its previous answer from earlier in this session, so
 * the feedback is the only thing that is new.
 */
function revisionPrompt(feedback: string): string {
  return [
    '## Revision requested',
    'A human reviewed your previous result and asked for changes:',
    feedback,
    'Revise your work accordingly. Your final message is captured as the new task output, so make it the complete revised deliverable.',
  ].join('\n\n');
}

/** Drop the runner, e.g. when the database closes. */
export function resetTaskRunner(): void {
  instance?.runner.dispose();
  instance = undefined;
}

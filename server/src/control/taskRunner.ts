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
import * as os from 'node:os';

import type {
  AgentSession,
  OutputItem,
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
import type { ClaudeRunOutcome, ClaudeStartRunRequest } from '../../../runtime/src/index.js';
import { ClaudeCliRuntime } from '../../../runtime/src/index.js';
import { assembleContext } from './contextAssembly.js';
import type { OfficeStorage } from './officeStorage.js';

const DEPS = { ids: uuidIdGenerator, clock: systemClock };

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
    const { bundle, contents } = await assembleContext(this.repos, task);

    // The session is the run's identity in the Office, and its id is what the
    // provider is told to use — one identifier, no mapping table.
    const session = startSession(
      {
        agentId: agent.id,
        projectId: task.projectId,
        provider: agent.provider,
        taskId: task.id,
        runtimeId: getTaskRuntime().descriptor.id,
      },
      DEPS,
    );
    const started = transitionTask(task, 'in_progress', DEPS.clock, {
      dependencyStatuses: dependencies.map((d) => d.status),
    });
    await this.storage.uow.run(async (repos) => {
      await repos.sessions.put(session);
      await repos.tasks.put(started);
    });

    this.live = { sessionId: session.id, taskId: task.id };
    this.listen();
    this.emitChange(task.id, session);

    const request: ClaudeStartRunRequest = {
      sessionId: session.id,
      agent,
      context: bundle,
      cwd: bundle.project.settings.workspacePaths[0] ?? os.homedir(),
      // The renderer needs the blob text; the runtime reads no storage itself.
      contents,
    };
    try {
      const result = await getTaskRuntime().startRun(request);
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
      await getTaskRuntime().stopRun(this.live.sessionId);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private listen(): void {
    this.unsubscribe?.();
    this.unsubscribe = getTaskRuntime().onOutcome((outcome) => {
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

/** Drop the runner, e.g. when the database closes. */
export function resetTaskRunner(): void {
  instance?.runner.dispose();
  instance = undefined;
}

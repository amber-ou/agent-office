/**
 * Project workspace: the project's own context, its knowledge and its tasks.
 *
 * Everything here is project-scoped and temporary. Nothing on this surface can
 * reach an agent's permanent configuration — there is no control that writes an
 * AgentDefinition, a Skill or an AgentKnowledge, by design (ADR 005).
 *
 * Fields mirror `Project`, `ProjectKnowledge` and `Task` exactly. Where the
 * domain guards a change (task status transitions, assignment, the dependency
 * graph) the server is the judge: the UI sends the move and shows the refusal.
 */

import { useState } from 'react';

import type {
  OfficeAgent,
  OfficeOutput,
  OfficeReviewNote,
  OfficeSession,
  OfficeTask,
  OfficeTaskInput,
  OutputContent,
} from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import type {
  CreateTaskFields,
  OfficeCommands,
  ProjectDetailView,
  ProjectKnowledgeFields,
} from './useOfficeState.js';

/** Kept in step with the domain's ProjectStatus / TaskStatus / TaskPriority. */
const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'failed',
] as const;
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const KNOWLEDGE_TYPES = [
  'markdown',
  'product_requirements',
  'ux_research',
  'user_flow',
  'design_system',
  'ui_specification',
  'api_documentation',
  'upload',
  'other',
] as const;

const fieldClass =
  'w-full bg-btn-bg border-2 border-border rounded-none px-4 py-2 text-text outline-none focus:border-accent';
const sectionClass = 'border-2 border-border p-8 flex flex-col gap-6 min-w-0';
const headingClass = 'text-accent-bright text-lg';
const rowClass = 'flex items-start justify-between gap-6 border-b border-border py-3 last:border-0';
const emptyClass = 'text-text-muted text-sm py-3';
const UNASSIGNED = '';

interface ProjectWorkspacePanelProps {
  detail: ProjectDetailView;
  /** The global agent library, for naming members and choosing an assignee. */
  agents: OfficeAgent[];
  commands: Pick<
    OfficeCommands,
    | 'closeProject'
    | 'updateProject'
    | 'createProjectKnowledge'
    | 'updateProjectKnowledge'
    | 'deleteProjectKnowledge'
    | 'createTask'
    | 'updateTask'
    | 'assignTask'
    | 'unassignTask'
    | 'setTaskStatus'
    | 'deleteTask'
    | 'runTask'
    | 'acceptTask'
    | 'requestTaskChanges'
    | 'cancelTaskRun'
    | 'viewOutput'
    | 'clearOutput'
  >;
  /** The output text last fetched, shown in place. */
  outputContent: OutputContent | null;
  error: string | null;
}

interface ProjectForm {
  name: string;
  description: string;
  status: string;
  workspacePaths: string;
  defaultProvider: string;
  defaultModel: string;
}

const EMPTY_KNOWLEDGE: ProjectKnowledgeFields & { tags: string[] } = {
  title: '',
  knowledgeType: 'markdown',
  content: '',
  tags: [],
};

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type HistoryEntry =
  | { kind: 'run'; session: OfficeSession; label: string; outputs: OfficeOutput[] }
  | { kind: 'note'; note: OfficeReviewNote };

/**
 * Runs and review feedback in one list, newest first.
 *
 * Each run is labelled by its place in its own task's sequence, so a task's
 * first result and its revisions are told apart without inventing a field for
 * it: the sessions themselves are the history.
 */
function buildHistory(detail: ProjectDetailView): HistoryEntry[] {
  // Number each task's runs oldest first: run 1, then revision 1, 2, ...
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const session of [...detail.sessions].reverse()) {
    const key = session.taskId ?? session.id;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    labels.set(session.id, nth === 1 ? 'run 1' : `revision ${nth - 1}`);
  }

  const runs: HistoryEntry[] = detail.sessions.map((session) => ({
    kind: 'run',
    session,
    label: labels.get(session.id) ?? 'run',
    outputs: detail.outputs.filter((output) => output.sessionId === session.id),
  }));
  const notes: HistoryEntry[] = detail.reviewNotes.map((note) => ({ kind: 'note', note }));
  return [...runs, ...notes].sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
}

function timeOf(entry: HistoryEntry): string {
  return entry.kind === 'run' ? entry.session.startedAt : entry.note.createdAt;
}

/** The run state of a task, as a short suffix. Empty when it has never run. */
function describeRun(session: OfficeSession | undefined): string {
  if (!session) {
    return '';
  }
  return session.status === 'failed' ? ' · run failed' : ` · run ${session.status}`;
}

/** One TaskInput rendered as a line the operator can read and retype. */
function describeInput(input: OfficeTaskInput): string {
  switch (input.kind) {
    case 'text':
      return `text: ${input.value ?? ''}`;
    case 'projectKnowledge':
      return `knowledge: ${input.knowledgeId ?? ''}`;
    case 'output':
      return `output: ${input.outputId ?? ''}`;
    default:
      return `file: ${input.path ?? ''}`;
  }
}

export function ProjectWorkspacePanel({
  detail,
  agents,
  commands,
  outputContent,
  error,
}: ProjectWorkspacePanelProps) {
  const project = detail.project;
  const memberIds = new Set(detail.memberships.map((m) => m.agentId));
  const members = agents.filter((a) => memberIds.has(a.id));
  const nameOf = (agentId: string): string => agents.find((a) => a.id === agentId)?.name ?? agentId;

  const [form, setForm] = useState<ProjectForm>(() => ({
    name: project.name,
    description: project.description,
    status: project.status,
    workspacePaths: project.workspacePaths.join(', '),
    defaultProvider: project.defaultProvider ?? '',
    defaultModel: project.defaultModel ?? '',
  }));
  const [knowledge, setKnowledge] = useState(EMPTY_KNOWLEDGE);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState<CreateTaskFields>({ title: '' });
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  const openTask = detail.tasks.find((t) => t.id === openTaskId) ?? null;
  // One run at a time, so a live session anywhere in the project blocks the
  // Run button on every other task.
  const liveSession = detail.sessions.find(
    (s) => s.status === 'starting' || s.status === 'running' || s.status === 'idle',
  );
  const lastSessionFor = (taskId: string): OfficeSession | undefined =>
    detail.sessions.find((s) => s.taskId === taskId);
  const reviewingTask = detail.tasks.find((t) => t.id === reviewingTaskId) ?? null;
  const taskTitleOf = (taskId: string | undefined): string =>
    detail.tasks.find((t) => t.id === taskId)?.title ?? taskId ?? 'session';
  const history = buildHistory(detail);

  const saveProject = () => {
    const name = form.name.trim();
    if (!name) {
      return;
    }
    commands.updateProject(project.id, {
      name,
      description: form.description,
      status: form.status,
      workspacePaths: splitList(form.workspacePaths),
      defaultProvider: form.defaultProvider.trim(),
      defaultModel: form.defaultModel.trim(),
    });
  };

  const submitKnowledge = () => {
    const title = knowledge.title.trim();
    if (!title || !knowledge.content) {
      return;
    }
    const fields: ProjectKnowledgeFields = {
      title,
      knowledgeType: knowledge.knowledgeType,
      content: knowledge.content,
      tags: knowledge.tags,
    };
    if (editingKnowledgeId) {
      commands.updateProjectKnowledge(editingKnowledgeId, fields);
    } else {
      commands.createProjectKnowledge(project.id, fields);
    }
    setKnowledge(EMPTY_KNOWLEDGE);
    setEditingKnowledgeId(null);
  };

  const submitTask = () => {
    const title = newTask.title.trim();
    if (!title) {
      return;
    }
    commands.createTask(project.id, { ...newTask, title });
    setNewTask({ title: '' });
  };

  return (
    <Modal
      isOpen
      onClose={commands.closeProject}
      title={`Project · ${project.name}`}
      zIndex={70}
      className="w-256 max-w-[92vw]"
    >
      <div
        className="flex flex-col gap-8 max-h-[70vh] overflow-y-auto"
        data-testid="project-workspace-panel"
      >
        {error && <div className="border-2 border-warning p-6 text-warning text-sm">{error}</div>}

        {/* ── Project context ──────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Project Context</h3>
          <div className="grid grid-cols-2 gap-4">
            <input
              className={fieldClass}
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <select
              className={fieldClass}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {PROJECT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className={`${fieldClass} h-40 resize-none`}
            placeholder="Project description / context"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="grid grid-cols-3 gap-4">
            <input
              className={fieldClass}
              placeholder="Workspace paths (comma separated)"
              value={form.workspacePaths}
              onChange={(e) => setForm({ ...form, workspacePaths: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Default provider"
              value={form.defaultProvider}
              onChange={(e) => setForm({ ...form, defaultProvider: e.target.value })}
            />
            <input
              className={fieldClass}
              placeholder="Default model"
              value={form.defaultModel}
              onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
            />
          </div>
          <div className="flex justify-end">
            <Button variant="accent" onClick={saveProject}>
              Save
            </Button>
          </div>
        </section>

        {/* ── Members ──────────────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Members</h3>
          <p className="text-text-muted text-sm">
            Only a member can be given a task here. Membership is managed in the office.
          </p>
          {members.length === 0 ? (
            <p className={emptyClass}>No agents in this project yet.</p>
          ) : (
            <ul>
              {members.map((agent) => (
                <li key={agent.id} className={rowClass}>
                  <span className="truncate">
                    {agent.name} <span className="text-text-muted text-sm">· {agent.role}</span>
                  </span>
                  <span className="text-text-muted text-sm shrink-0">
                    {detail.tasks.filter((t) => t.assignedAgentId === agent.id).length} task(s)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Project knowledge ────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Project Knowledge</h3>
          <p className="text-text-muted text-sm">
            Belongs to this project alone. It never becomes an agent's permanent knowledge.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <input
              className={fieldClass}
              placeholder="Title"
              value={knowledge.title}
              onChange={(e) => setKnowledge({ ...knowledge, title: e.target.value })}
            />
            <select
              className={fieldClass}
              value={knowledge.knowledgeType}
              onChange={(e) => setKnowledge({ ...knowledge, knowledgeType: e.target.value })}
            >
              {KNOWLEDGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <input
            className={fieldClass}
            placeholder="Tags (comma separated)"
            value={knowledge.tags.join(', ')}
            onChange={(e) => setKnowledge({ ...knowledge, tags: splitList(e.target.value) })}
          />
          <textarea
            className={`${fieldClass} h-40 resize-none`}
            placeholder="Knowledge content"
            value={knowledge.content}
            onChange={(e) => setKnowledge({ ...knowledge, content: e.target.value })}
          />
          <div className="flex gap-4 justify-end">
            {editingKnowledgeId && (
              <Button
                onClick={() => {
                  setKnowledge(EMPTY_KNOWLEDGE);
                  setEditingKnowledgeId(null);
                }}
              >
                Cancel
              </Button>
            )}
            <Button variant="accent" onClick={submitKnowledge}>
              {editingKnowledgeId ? 'Save knowledge' : 'Add knowledge'}
            </Button>
          </div>
          {detail.knowledge.length === 0 ? (
            <p className={emptyClass}>No project knowledge yet.</p>
          ) : (
            <ul>
              {detail.knowledge.map((item) => (
                <li key={item.id} className={rowClass}>
                  <span className="truncate min-w-0">
                    {item.title} <span className="text-text-muted text-sm">· {item.type}</span>
                    {item.contentReadable === false && (
                      <span className="text-warning text-sm"> · content unavailable</span>
                    )}
                  </span>
                  <span className="flex gap-4 shrink-0">
                    <Button
                      size="sm"
                      variant={item.contentReadable === false ? 'disabled' : 'default'}
                      disabled={item.contentReadable === false}
                      onClick={() => {
                        setKnowledge({
                          title: item.title,
                          knowledgeType: item.type,
                          content: item.content ?? '',
                          tags: item.tags,
                        });
                        setEditingKnowledgeId(item.id);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" onClick={() => commands.deleteProjectKnowledge(item.id)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Tasks ────────────────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Tasks</h3>
          <p className="text-text-muted text-sm">
            A task needs no agent to exist. Split the work as small as you like and assign later.
          </p>
          <div className="grid grid-cols-3 gap-4">
            <input
              className={fieldClass}
              placeholder="New task title"
              value={newTask.title}
              onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submitTask()}
            />
            <select
              className={fieldClass}
              value={newTask.priority ?? 'normal'}
              onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
            >
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
            <select
              className={fieldClass}
              value={newTask.assignedAgentId ?? UNASSIGNED}
              onChange={(e) =>
                setNewTask({
                  ...newTask,
                  ...(e.target.value === UNASSIGNED
                    ? { assignedAgentId: undefined }
                    : { assignedAgentId: e.target.value }),
                })
              }
            >
              <option value={UNASSIGNED}>Unassigned</option>
              {members.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-4">
            <input
              className={fieldClass}
              placeholder="Description / instructions & acceptance criteria"
              value={newTask.description ?? ''}
              onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
            />
            <Button variant="accent" onClick={submitTask}>
              Create
            </Button>
          </div>
          {detail.tasks.length === 0 ? (
            <p className={emptyClass}>No tasks yet.</p>
          ) : (
            <ul>
              {detail.tasks.map((task) => (
                <li key={task.id} className={rowClass}>
                  <span className="truncate min-w-0">
                    {task.title}{' '}
                    <span className="text-text-muted text-sm">
                      · {task.status} · {task.priority} ·{' '}
                      {task.assignedAgentId ? nameOf(task.assignedAgentId) : 'unassigned'}
                      {task.dependencies.length > 0 && ` · ${task.dependencies.length} dep(s)`}
                      {describeRun(lastSessionFor(task.id))}
                    </span>
                  </span>
                  <span className="flex gap-4 shrink-0">
                    {liveSession?.taskId === task.id ? (
                      <Button size="sm" onClick={() => commands.cancelTaskRun()}>
                        Stop
                      </Button>
                    ) : task.status === 'review' ? (
                      <>
                        <Button
                          size="sm"
                          variant="accent"
                          onClick={() => commands.acceptTask(task.id)}
                          title="Accept this result: the task becomes done"
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant={reviewingTaskId === task.id ? 'active' : 'default'}
                          onClick={() =>
                            setReviewingTaskId(reviewingTaskId === task.id ? null : task.id)
                          }
                        >
                          Request changes
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant={liveSession ? 'disabled' : 'accent'}
                        disabled={liveSession !== undefined}
                        onClick={() => commands.runTask(task.id)}
                        title="Run this task with its assigned agent"
                      >
                        Run
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={task.id === openTaskId ? 'active' : 'default'}
                      onClick={() => setOpenTaskId(task.id === openTaskId ? null : task.id)}
                    >
                      {task.id === openTaskId ? 'Close' : 'Open'}
                    </Button>
                    <Button size="sm" onClick={() => commands.deleteTask(task.id)}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {reviewingTask && (
          <section className={sectionClass}>
            <h3 className={headingClass}>Request changes · {reviewingTask.title}</h3>
            <p className="text-text-muted text-sm">
              The agent continues the same Claude session, so it still has its earlier work. Say
              only what should change. This feedback belongs to the task's history — it never
              becomes the agent's knowledge.
            </p>
            <textarea
              className={`${fieldClass} h-40 resize-none`}
              placeholder="What needs to change?"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <div className="flex gap-4 justify-end">
              <Button
                onClick={() => {
                  setReviewingTaskId(null);
                  setFeedback('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant={feedback.trim() && !liveSession ? 'accent' : 'disabled'}
                disabled={!feedback.trim() || liveSession !== undefined}
                onClick={() => {
                  commands.requestTaskChanges(reviewingTask.id, feedback.trim());
                  setReviewingTaskId(null);
                  setFeedback('');
                }}
              >
                Send &amp; revise
              </Button>
            </div>
          </section>
        )}

        {/* ── Runs and results ─────────────────────────────────── */}
        <section className={sectionClass}>
          <h3 className={headingClass}>Runs &amp; Results</h3>
          {history.length === 0 ? (
            <p className={emptyClass}>Nothing has run yet.</p>
          ) : (
            <ul>
              {history.map((entry) =>
                entry.kind === 'note' ? (
                  <li key={entry.note.id} className={rowClass}>
                    <span className="min-w-0">
                      <span className="text-text-muted text-sm">
                        {taskTitleOf(entry.note.taskId)} · you asked for changes
                      </span>
                      <span className="block truncate">{entry.note.body}</span>
                    </span>
                  </li>
                ) : (
                  <li key={entry.session.id} className={rowClass}>
                    <span className="truncate min-w-0">
                      {taskTitleOf(entry.session.taskId)}{' '}
                      <span className="text-text-muted text-sm">
                        · {entry.label} · {entry.session.status} · {nameOf(entry.session.agentId)}
                      </span>
                      {entry.session.error && (
                        <span className="text-warning text-sm block truncate">
                          {entry.session.error}
                        </span>
                      )}
                    </span>
                    <span className="flex gap-4 shrink-0">
                      {entry.outputs.map((output) => (
                        <Button
                          key={output.id}
                          size="sm"
                          onClick={() => commands.viewOutput(output.id)}
                        >
                          View result
                        </Button>
                      ))}
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
          {outputContent && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-6">
                <span className="text-accent-bright truncate">{outputContent.title}</span>
                <Button size="sm" onClick={() => commands.clearOutput()}>
                  Close result
                </Button>
              </div>
              <pre className="bg-btn-bg border-2 border-border p-6 text-sm whitespace-pre-wrap max-h-96 overflow-y-auto">
                {outputContent.readable
                  ? (outputContent.content ?? '')
                  : 'The result could not be read.'}
              </pre>
            </div>
          )}
        </section>

        {openTask && (
          <TaskDetail
            key={openTask.id}
            task={openTask}
            tasks={detail.tasks}
            members={members}
            commands={commands}
          />
        )}
      </div>
    </Modal>
  );
}

interface TaskDetailProps {
  task: OfficeTask;
  tasks: OfficeTask[];
  members: OfficeAgent[];
  commands: Pick<
    OfficeCommands,
    'updateTask' | 'assignTask' | 'unassignTask' | 'setTaskStatus' | 'deleteTask'
  >;
}

/**
 * One task, in full.
 *
 * Status and assignment are sent as their own commands because the domain
 * guards them; an illegal move comes back as an error rather than being hidden
 * here, so the UI cannot drift from the transition table.
 */
function TaskDetail({ task, tasks, members, commands }: TaskDetailProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [parentTaskId, setParentTaskId] = useState(task.parentTaskId ?? UNASSIGNED);
  const [dependencies, setDependencies] = useState<string[]>(task.dependencies);
  const [inputs, setInputs] = useState<OfficeTaskInput[]>(task.inputs);
  const [inputKind, setInputKind] = useState('text');
  const [inputValue, setInputValue] = useState('');

  const others = tasks.filter((t) => t.id !== task.id);

  const save = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }
    commands.updateTask(task.id, {
      title: trimmed,
      description,
      priority,
      dependencies,
      inputs,
      ...(parentTaskId === UNASSIGNED ? { clearParentTask: true } : { parentTaskId }),
    });
  };

  const addInput = () => {
    const value = inputValue.trim();
    if (!value) {
      return;
    }
    const next: OfficeTaskInput =
      inputKind === 'text'
        ? { kind: 'text', value }
        : inputKind === 'projectKnowledge'
          ? { kind: 'projectKnowledge', knowledgeId: value }
          : { kind: 'file', path: value };
    setInputs([...inputs, next]);
    setInputValue('');
  };

  return (
    <section className={sectionClass}>
      <h3 className={headingClass}>Task · {task.title}</h3>
      <input
        className={fieldClass}
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className={`${fieldClass} h-40 resize-none`}
        placeholder="Instructions, and what done looks like"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-4">
        <select
          className={fieldClass}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          {TASK_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              priority: {value}
            </option>
          ))}
        </select>
        <select
          className={fieldClass}
          value={parentTaskId}
          onChange={(e) => setParentTaskId(e.target.value)}
        >
          <option value={UNASSIGNED}>No parent task</option>
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              part of: {other.title}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-4">
        <span className="text-text-muted text-sm">
          Depends on — this task cannot start until these are done. Not the same as a parent.
        </span>
        {others.length === 0 ? (
          <p className={emptyClass}>No other tasks to depend on.</p>
        ) : (
          <ul>
            {others.map((other) => (
              <li key={other.id} className={rowClass}>
                <span className="truncate min-w-0">
                  {other.title} <span className="text-text-muted text-sm">· {other.status}</span>
                </span>
                <Button
                  size="sm"
                  variant={dependencies.includes(other.id) ? 'active' : 'default'}
                  onClick={() =>
                    setDependencies(
                      dependencies.includes(other.id)
                        ? dependencies.filter((id) => id !== other.id)
                        : [...dependencies, other.id],
                    )
                  }
                >
                  {dependencies.includes(other.id) ? 'Depends' : 'Add'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <span className="text-text-muted text-sm">Inputs / references</span>
        <div className="grid grid-cols-3 gap-4">
          <select
            className={fieldClass}
            value={inputKind}
            onChange={(e) => setInputKind(e.target.value)}
          >
            <option value="text">text</option>
            <option value="projectKnowledge">project knowledge id</option>
            <option value="file">file path</option>
          </select>
          <input
            className={fieldClass}
            placeholder="Value"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addInput()}
          />
          <Button onClick={addInput}>Add input</Button>
        </div>
        {inputs.length === 0 ? (
          <p className={emptyClass}>No inputs.</p>
        ) : (
          <ul>
            {inputs.map((input, index) => (
              <li key={`${input.kind}-${index}`} className={rowClass}>
                <span className="truncate min-w-0 text-sm">{describeInput(input)}</span>
                <Button size="sm" onClick={() => setInputs(inputs.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="accent" onClick={save}>
          Save task
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 border-t border-border pt-6">
        <select
          className={fieldClass}
          value={task.assignedAgentId ?? UNASSIGNED}
          onChange={(e) =>
            e.target.value === UNASSIGNED
              ? commands.unassignTask(task.id)
              : commands.assignTask(task.id, e.target.value)
          }
        >
          <option value={UNASSIGNED}>Unassigned</option>
          {members.map((agent) => (
            <option key={agent.id} value={agent.id}>
              assigned to: {agent.name}
            </option>
          ))}
        </select>
        <select
          className={fieldClass}
          value={task.status}
          onChange={(e) => commands.setTaskStatus(task.id, e.target.value)}
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              status: {status}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

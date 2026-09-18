/**
 * Review notes — the human half of the work cycle.
 *
 * When an operator sends a task back for changes, what they said is part of
 * that task's history: it belongs beside the runs and the outputs, in order,
 * and it is read back when the history is shown. It is emphatically NOT agent
 * memory — nothing here is ever copied into an AgentDefinition, a Skill or an
 * AgentKnowledge, and there is no function anywhere that would (ADR 005).
 *
 * This is an APPLICATION-level record, not a domain entity: the frozen M1 model
 * needs no amendment to represent continuation, so it gets none. The port lives
 * here, beside its adapter, rather than in `domain/src/repositories.ts`.
 */

import type { SessionId, TaskId, Timestamp } from '../../domain/src/index.js';

export interface ReviewNote {
  id: string;
  taskId: TaskId;
  /** The run this note was written about. Absent if the note predates any run. */
  aboutSessionId?: SessionId;
  /** The revision run this note started, once one exists. */
  triggeredSessionId?: SessionId;
  /** Who wrote it. Only a human does, in this phase. */
  author: 'human';
  body: string;
  createdAt: Timestamp;
}

export interface ReviewNoteStore {
  listByTask(taskId: TaskId): Promise<ReviewNote[]>;
  /** Every note for every task in a project, oldest first. */
  listByProject(projectId: string): Promise<ReviewNote[]>;
  put(note: ReviewNote): Promise<void>;
}

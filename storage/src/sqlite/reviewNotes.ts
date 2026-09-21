/**
 * SQLite adapter for `ReviewNoteStore`.
 *
 * Shares the one connection with every repository, so a note written inside
 * `SqliteUnitOfWork.run` is part of the same transaction as the session and the
 * task transition it belongs with.
 */

import type { SessionId, TaskId } from '../../../domain/src/index.js';
import type { ReviewNote, ReviewNoteStore } from '../reviewNotes.js';
import type { Row, SqliteDatabase } from './database.js';

export class SqliteReviewNoteStore implements ReviewNoteStore {
  constructor(private readonly db: SqliteDatabase) {}

  async listByTask(taskId: TaskId): Promise<ReviewNote[]> {
    return this.db
      .all('SELECT * FROM task_review_notes WHERE task_id = ? ORDER BY created_at, id', [taskId])
      .map(toReviewNote);
  }

  async listByProject(projectId: string): Promise<ReviewNote[]> {
    return this.db
      .all(
        `SELECT n.* FROM task_review_notes n
           JOIN tasks t ON t.id = n.task_id
          WHERE t.project_id = ?
          ORDER BY n.created_at, n.id`,
        [projectId],
      )
      .map(toReviewNote);
  }

  async put(note: ReviewNote): Promise<void> {
    this.db.run(
      `INSERT INTO task_review_notes
         (id, task_id, about_session_id, triggered_session_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         about_session_id = excluded.about_session_id,
         triggered_session_id = excluded.triggered_session_id,
         body = excluded.body`,
      [
        note.id,
        note.taskId,
        note.aboutSessionId ?? null,
        note.triggeredSessionId ?? null,
        note.author,
        note.body,
        note.createdAt,
      ],
    );
  }
}

function toReviewNote(row: Row): ReviewNote {
  return {
    id: String(row['id']),
    taskId: String(row['task_id']) as TaskId,
    ...(row['about_session_id'] === null
      ? {}
      : { aboutSessionId: String(row['about_session_id']) as SessionId }),
    ...(row['triggered_session_id'] === null
      ? {}
      : { triggeredSessionId: String(row['triggered_session_id']) as SessionId }),
    author: 'human',
    body: String(row['body']),
    createdAt: String(row['created_at']),
  };
}

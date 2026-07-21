// handlers/listUserAssignments.ts
//
// Backs GET /api/assignments/{userId} - curator-only. Like
// listMyAssignments.ts, but for an arbitrary target user rather than the
// calling curator themselves, plus the per-axis reviewStatus
// (not_started/in_review/passed) an admin needs that a regular user's own
// "my assignments" view doesn't.

import type { Queryable } from '../db.js';
import { loadAxisDecidedBatch, loadReviewStatusBatch, type AxisDecided, type ReviewStatus } from '../reviewShared.js';
import { UserNotFoundError } from './errors.js';

export interface UserAssignmentSummary {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  assignedAt: Date;
  assignedByUsername: string | null;
  axisDecided: AxisDecided;
  reviewStatus: ReviewStatus;
}

export async function listUserAssignments(db: Queryable, targetUserId: string): Promise<UserAssignmentSummary[]> {
  const userCheck = await db.query('select 1 from users where user_id = $1', [targetUserId]);
  if ((userCheck.rowCount ?? 0) === 0) throw new UserNotFoundError(targetUserId);

  const result = await db.query<{
    word_id: string;
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_type: 'phrase' | null;
    assigned_at: Date;
    assigned_by_username: string | null;
  }>(
    `select a.word_id, gr.display_text, gr.syllables, gr.definition, gr.entry_type, a.assigned_at,
            ub.username as assigned_by_username
     from assignments a
     join golden_record gr on gr.word_id = a.word_id
     left join users ub on ub.user_id = a.assigned_by
     where a.user_id = $1
     order by a.assigned_at asc`,
    [targetUserId],
  );
  const wordIds = result.rows.map((row) => row.word_id);
  const [axisDecidedByWord, reviewStatusByWord] = await Promise.all([
    loadAxisDecidedBatch(db, wordIds, targetUserId),
    loadReviewStatusBatch(db, wordIds, targetUserId),
  ]);
  return result.rows.map((row) => ({
    wordId: row.word_id,
    displayText: row.display_text,
    syllables: row.syllables,
    definition: row.definition,
    entryType: row.entry_type,
    assignedAt: row.assigned_at,
    assignedByUsername: row.assigned_by_username,
    axisDecided: axisDecidedByWord.get(row.word_id)!,
    reviewStatus: reviewStatusByWord.get(row.word_id)!,
  }));
}

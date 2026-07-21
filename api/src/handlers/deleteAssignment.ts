// handlers/deleteAssignment.ts
//
// Backs DELETE /api/assignments/{userId}/{wordId} - curator-only. Removes
// only the assignments row itself; never touches word_decisions or
// contributions - unassigning doesn't retract work already done or
// decided, it only removes the admin's record of "this word is on this
// person's plate."

import type { Queryable } from '../db.js';
import { AssignmentNotFoundError } from './errors.js';

export async function deleteAssignment(db: Queryable, userId: string, wordId: string): Promise<void> {
  const result = await db.query('delete from assignments where user_id = $1 and word_id = $2', [userId, wordId]);
  if ((result.rowCount ?? 0) === 0) throw new AssignmentNotFoundError(userId, wordId);
}

// handlers/createAssignments.ts
//
// Backs POST /api/assignments - curator-only, single or bulk word_id
// assignment to one user. Uses a set-based insert with ON CONFLICT DO
// NOTHING rather than createWord.ts's pre-check-then-catch-23505 shape:
// re-submitting a word list that overlaps a previous assignment is a
// routine, expected outcome here (not exceptional the way a duplicate
// word_id create is), so it's reported back as alreadyAssigned rather
// than thrown on, and one set-based statement avoids the N-row
// check-then-insert race a loop would have.

import type { Queryable } from '../db.js';
import { UserNotFoundError, WordIdsNotFoundError } from './errors.js';

export interface CreateAssignmentsInput {
  userId: string;
  wordIds: string[];
}

export interface CreateAssignmentsResult {
  created: string[];
  alreadyAssigned: string[];
}

export async function createAssignments(
  db: Queryable,
  input: CreateAssignmentsInput,
  assignedBy: string,
): Promise<CreateAssignmentsResult> {
  const userCheck = await db.query('select 1 from users where user_id = $1', [input.userId]);
  if ((userCheck.rowCount ?? 0) === 0) throw new UserNotFoundError(input.userId);

  const wordCheck = await db.query<{ word_id: string }>('select word_id from golden_record where word_id = any($1)', [
    input.wordIds,
  ]);
  const existingWords = new Set(wordCheck.rows.map((row) => row.word_id));
  const missing = input.wordIds.filter((w) => !existingWords.has(w));
  if (missing.length > 0) throw new WordIdsNotFoundError(missing);

  const inserted = await db.query<{ word_id: string }>(
    `insert into assignments (word_id, user_id, assigned_by)
     select w, $2, $3 from unnest($1::text[]) as w
     on conflict (word_id, user_id) do nothing
     returning word_id`,
    [input.wordIds, input.userId, assignedBy],
  );
  const created = new Set(inserted.rows.map((row) => row.word_id));
  return {
    created: input.wordIds.filter((w) => created.has(w)),
    alreadyAssigned: input.wordIds.filter((w) => !created.has(w)),
  };
}

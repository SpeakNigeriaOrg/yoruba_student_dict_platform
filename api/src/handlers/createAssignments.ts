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

/** Server-resolved alternatives to spelling out every word_id: 'all' is
 * the whole golden_record, 'incomplete' is every word still missing at
 * least one verification layer FOR THIS ASSIGNEE - the same four layers
 * AxisDecided reports, so what a curator sees as a non-green badge in
 * AdminUserDetail is exactly what 'incomplete' picks up. Audio is
 * per-user by design (see AxisDecided.audio), so 'incomplete' is
 * genuinely user-relative: a word everyone else has recorded is still
 * incomplete for someone who hasn't. Resolved here rather than in the
 * client so the word list can't go stale between listing and assigning. */
export type AssignmentScope = 'all' | 'incomplete';

export interface CreateAssignmentsInput {
  userId: string;
  /** Mutually exclusive with scope; exactly one of the two is set. */
  wordIds?: string[];
  scope?: AssignmentScope;
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

  let wordIds: string[];
  if (input.scope) {
    wordIds = await resolveScope(db, input.scope, input.userId);
    if (wordIds.length === 0) return { created: [], alreadyAssigned: [] };
  } else {
    wordIds = input.wordIds ?? [];
    // Only the explicit-list path can name a word that doesn't exist -
    // scope-resolved ids come straight out of golden_record.
    const wordCheck = await db.query<{ word_id: string }>('select word_id from golden_record where word_id = any($1)', [
      wordIds,
    ]);
    const existingWords = new Set(wordCheck.rows.map((row) => row.word_id));
    const missing = wordIds.filter((w) => !existingWords.has(w));
    if (missing.length > 0) throw new WordIdsNotFoundError(missing);
  }

  const inserted = await db.query<{ word_id: string }>(
    `insert into assignments (word_id, user_id, assigned_by)
     select w, $2, $3 from unnest($1::text[]) as w
     on conflict (word_id, user_id) do nothing
     returning word_id`,
    [wordIds, input.userId, assignedBy],
  );
  const created = new Set(inserted.rows.map((row) => row.word_id));
  return {
    created: wordIds.filter((w) => created.has(w)),
    alreadyAssigned: wordIds.filter((w) => !created.has(w)),
  };
}

async function resolveScope(db: Queryable, scope: AssignmentScope, userId: string): Promise<string[]> {
  if (scope === 'all') {
    const rows = await db.query<{ word_id: string }>('select word_id from golden_record order by word_id');
    return rows.rows.map((r) => r.word_id);
  }
  const rows = await db.query<{ word_id: string }>(
    `select g.word_id from golden_record g
     where (
       select count(distinct d.axis) from word_decisions d
       where d.word_id = g.word_id and d.axis in ('spelling', 'definition', 'etymology')
     ) < 3
     or not exists (
       select 1 from utterances u join speakers s on s.speaker_id = u.speaker_id
       where u.word_id = g.word_id and s.user_id = $1
     )
     order by g.word_id`,
    [userId],
  );
  return rows.rows.map((r) => r.word_id);
}

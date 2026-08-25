// handlers/listRecentWords.ts
//
// Backs GET /api/words/recent - curator-only. The newest entries by
// golden_record.created_at (0021), each flagged with whether the user a
// curator is looking at already has it assigned.
//
// WHY THIS IS NOT AN AssignmentScope. createAssignments' 'all' and
// 'incomplete' resolve their word set on the server at submit time, so the
// curator cannot act on a list that went stale. "Recently added" cannot work
// that way and shouldn't: the point is to LOOK at the batch that just landed
// and decide it is the right one. The resolution happens in the curator's
// eyes, so what they picked travels back as explicit word_ids - the honest
// record of a human choice, and already validated by createAssignments'
// existing wordIds path.
//
// `alreadyAssigned` is computed here rather than left to the client diffing
// against the assignments list, because the browse is capped at `limit` while
// the assignment list is not: the client would have to hold both to answer a
// question one query already answers.

import type { Queryable } from '../db.js';
import { UserNotFoundError } from './errors.js';

export interface RecentWordSummary {
  wordId: string;
  displayText: string;
  definition: string | null;
  entryType: 'phrase' | null;
  createdAt: Date;
  alreadyAssigned: boolean;
}

/** Enough to cover a large day's additions without becoming a second way to
 * page the whole dictionary - that is what 'all' is for. A curator who added
 * more than this in one batch still gets the newest slice, and the day heading
 * in the UI says how many it is showing. */
export const RECENT_WORDS_DEFAULT_LIMIT = 200;
export const RECENT_WORDS_MAX_LIMIT = 500;

export async function listRecentWords(
  db: Queryable,
  forUserId: string,
  limit: number = RECENT_WORDS_DEFAULT_LIMIT,
): Promise<RecentWordSummary[]> {
  const userCheck = await db.query('select 1 from users where user_id = $1', [forUserId]);
  if ((userCheck.rowCount ?? 0) === 0) throw new UserNotFoundError(forUserId);

  const capped = Math.min(Math.max(Math.trunc(limit), 1), RECENT_WORDS_MAX_LIMIT);
  const result = await db.query<{
    word_id: string;
    display_text: string;
    definition: string | null;
    entry_type: 'phrase' | null;
    created_at: Date;
    already_assigned: boolean;
  }>(
    // word_id is the tiebreaker so a batch inserted inside one transaction -
    // where every row shares a created_at to the microsecond - still comes back
    // in a stable order across calls, rather than shuffling between reloads.
    `select gr.word_id, gr.display_text, gr.definition, gr.entry_type, gr.created_at,
            exists (select 1 from assignments a where a.word_id = gr.word_id and a.user_id = $1) as already_assigned
     from golden_record gr
     order by gr.created_at desc, gr.word_id asc
     limit $2`,
    [forUserId, capped],
  );
  return result.rows.map((row) => ({
    wordId: row.word_id,
    displayText: row.display_text,
    definition: row.definition,
    entryType: row.entry_type,
    createdAt: row.created_at,
    alreadyAssigned: row.already_assigned,
  }));
}

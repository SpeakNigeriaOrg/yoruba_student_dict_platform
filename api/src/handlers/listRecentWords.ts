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
import { UserNotFoundError, WordNotFoundError } from './errors.js';

export interface RecentWordSummary {
  wordId: string;
  displayText: string;
  definition: string | null;
  entryType: 'phrase' | null;
  createdAt: Date;
  alreadyAssigned: boolean;
}

export interface RecentWordsPage {
  words: RecentWordSummary[];
  /** Whether anything older than the last word returned exists - so the UI
   * offers "Show older words" only when there are some. */
  hasMore: boolean;
}

/** One page of the browse. It used to be the whole browse: the newest 200 and
 * nothing behind them, so a curator could not reach - or assign from the list -
 * anything added before the latest 200. Older words are now fetched a page at a
 * time with `before`. */
export const RECENT_WORDS_DEFAULT_LIMIT = 200;
export const RECENT_WORDS_MAX_LIMIT = 500;

/** `before` is the word_id of the last word already shown; the page continues
 * from there. A word id rather than a timestamp, because created_at is stored to
 * the microsecond and a JavaScript Date round-trip keeps only milliseconds - a
 * timestamp cursor would skip or repeat words added within the same millisecond,
 * which is exactly what a bulk import does. The database looks the position up
 * from the id at full precision. */
export async function listRecentWords(
  db: Queryable,
  forUserId: string,
  limit: number = RECENT_WORDS_DEFAULT_LIMIT,
  before?: string,
): Promise<RecentWordsPage> {
  const userCheck = await db.query('select 1 from users where user_id = $1', [forUserId]);
  if ((userCheck.rowCount ?? 0) === 0) throw new UserNotFoundError(forUserId);
  if (before !== undefined) {
    // A cursor word deleted since the page was loaded has no position to continue
    // from; saying so beats silently returning nothing, which reads as "no older words".
    const cursorCheck = await db.query('select 1 from golden_record where word_id = $1', [before]);
    if ((cursorCheck.rowCount ?? 0) === 0) throw new WordNotFoundError(before);
  }

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
     where $3::text is null
        or exists (
          select 1 from golden_record c
          where c.word_id = $3
            and (gr.created_at < c.created_at or (gr.created_at = c.created_at and gr.word_id > c.word_id))
        )
     order by gr.created_at desc, gr.word_id asc
     limit $2 + 1`,
    // One extra row answers hasMore without a second count query.
    [forUserId, capped, before ?? null],
  );
  const hasMore = result.rows.length > capped;
  const words = result.rows.slice(0, capped).map((row) => ({
    wordId: row.word_id,
    displayText: row.display_text,
    definition: row.definition,
    entryType: row.entry_type,
    createdAt: row.created_at,
    alreadyAssigned: row.already_assigned,
  }));
  return { words, hasMore };
}

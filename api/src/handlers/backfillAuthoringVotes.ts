// handlers/backfillAuthoringVotes.ts
//
// Gives words created before authoringVote.ts the author's vote they were
// created without. One-off; see scripts/backfillAuthoringVotes.mjs.
//
// WHAT IT WRITES, AND ONLY THIS: rows in `contributions`. It never writes
// golden_record, golden_record_components, upstream_citations, word_decisions,
// utterances, speakers or syllable_observations. Nothing about what a word IS,
// how it is spelled, what it is made of, or who recorded it changes here - the
// backfill adds evidence about words, not content to them. That matters
// especially for the seeded material: those words arrived by direct database
// writes with audio attached to placeholder speakers, and none of that is
// reachable from an insert into this table.
//
// It also never SUPERSEDES. submitContribution marks the submitter's own prior
// active vote superseded when they change their mind, which is right for a
// person at a form and wrong for a migration: a word where the target user has
// already voted is a word that already has their real opinion on record, and
// replacing it with a synthesized "keep_ours" would overwrite genuine evidence
// with a guess about it. Those words are skipped and reported.
//
// ATTRIBUTION IS A CHOICE, NOT A RECOVERY. golden_record.updated_by is the last
// person to touch the row, which is not the same as its author, and for the
// imported vocabulary it is frequently null. There is nothing in the database
// that reliably says who authored a seeded word. So every backfilled vote is
// attributed to one named user passed in by the caller, and its note says it
// was backfilled rather than typed - an honest "this is the project owner's
// position on the existing corpus", instead of a per-word attribution that
// would look precise and be invented.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { submitContributionInTransaction } from './submitContribution.js';
import { AUTHORING_ENTRY_VOTE, AUTHORING_ETYMOLOGY_VOTE } from './authoringVote.js';

/** Says in the row itself that this was a migration, not somebody at a form. */
export const BACKFILL_NOTE = 'Backfilled: the position this entry was created holding.';

export type SkipReason =
  /** The target user already has an active vote here - their real opinion. */
  | 'already_voted'
  /** The axis carries a word_decisions row, so the question is already settled. */
  | 'already_decided'
  /** Etymology only: no components on record, and silence is not a vote for atomic. */
  | 'no_components';

export interface BackfillPlanItem {
  wordId: string;
  axis: 'entry' | 'etymology';
}

export interface BackfillSkip extends BackfillPlanItem {
  reason: SkipReason;
}

export interface BackfillPlan {
  planned: BackfillPlanItem[];
  skipped: BackfillSkip[];
}

/** Works out what would be written, touching nothing. The script's dry run is
 * literally this and a report, so what it prints is what --apply then does. */
export async function planAuthoringVoteBackfill(client: Queryable, userId: string): Promise<BackfillPlan> {
  const words = await client.query<{
    word_id: string;
    has_components: boolean;
    entry_voted: boolean;
    etymology_voted: boolean;
    entry_decided: boolean;
    etymology_decided: boolean;
  }>(
    `select g.word_id,
            exists (select 1 from golden_record_components c where c.word_id = g.word_id) as has_components,
            exists (select 1 from contributions n
                     where n.word_id = g.word_id and n.axis = 'entry'
                       and n.submitted_by = $1 and n.status = 'active') as entry_voted,
            exists (select 1 from contributions n
                     where n.word_id = g.word_id and n.axis = 'etymology'
                       and n.submitted_by = $1 and n.status = 'active') as etymology_voted,
            exists (select 1 from word_decisions d
                     where d.word_id = g.word_id and d.axis = 'entry') as entry_decided,
            exists (select 1 from word_decisions d
                     where d.word_id = g.word_id and d.axis = 'etymology') as etymology_decided
       from golden_record g
      order by g.word_id`,
    [userId],
  );

  const plan: BackfillPlan = { planned: [], skipped: [] };
  for (const w of words.rows) {
    const push = (axis: 'entry' | 'etymology', reason: SkipReason | null) =>
      reason ? plan.skipped.push({ wordId: w.word_id, axis, reason }) : plan.planned.push({ wordId: w.word_id, axis });

    push('entry', w.entry_voted ? 'already_voted' : w.entry_decided ? 'already_decided' : null);
    // Same rule the live path applies: a decomposition nobody recorded is not a claim that the
    // word is atomic, so there is nothing here to vote for.
    push(
      'etymology',
      !w.has_components ? 'no_components' : w.etymology_voted ? 'already_voted' : w.etymology_decided ? 'already_decided' : null,
    );
  }
  return plan;
}

export interface BackfillResult extends BackfillPlan {
  written: number;
  /** Planned items this call did not reach, because `limit` stopped it. Zero means done. */
  remaining: number;
  failed: Array<BackfillPlanItem & { error: string }>;
}

/** Applies the plan, one word-axis per transaction, at most `limit` of them.
 *
 * Per item rather than one transaction over thousands of rows: a single word
 * that cannot resolve an outcome (a phrase whose components went missing, say)
 * should be reported and stepped over, not take the whole corpus with it.
 *
 * BOUNDED because the caller may be an HTTP request. Each item is roughly five
 * round trips to Postgres, so a few hundred of them comfortably outlives an
 * HTTP gateway timeout - which is what happened the first time this ran from
 * the Review tab against the real corpus: 163 votes, one request, a 500 from
 * the gateway and no report of the many that had in fact been written.
 *
 * Resumable rather than transactional across the batch, and deliberately: every
 * item commits on its own, so an interrupted run leaves completed work
 * completed, and re-planning simply finds less to do. `remaining` lets the
 * caller drive the rest without recomputing what it already knows. */
export async function applyAuthoringVoteBackfill(
  pool: pg.Pool,
  userId: string,
  plan: BackfillPlan,
  limit = Number.POSITIVE_INFINITY,
): Promise<BackfillResult> {
  const batch = plan.planned.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
  const result: BackfillResult = { ...plan, written: 0, remaining: plan.planned.length - batch.length, failed: [] };

  for (const item of batch) {
    try {
      // eslint-disable-next-line no-await-in-loop
      // Branched rather than a ternary inside the object: axis and proposedValue are correlated
      // in SubmitContributionInput's union, and a computed axis widens both halves past it.
      const submission =
        item.axis === 'entry'
          ? ({ axis: 'entry', wordId: item.wordId, proposedValue: { ...AUTHORING_ENTRY_VOTE }, note: BACKFILL_NOTE } as const)
          : ({ axis: 'etymology', wordId: item.wordId, proposedValue: { ...AUTHORING_ETYMOLOGY_VOTE }, note: BACKFILL_NOTE } as const);
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(pool, (client) => submitContributionInTransaction(client, submission, userId));
      result.written += 1;
    } catch (err) {
      result.failed.push({ ...item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// handlers/backfillEntryUsageFields.ts
//
// Completes every entry-axis vote and decision stored before 0029 with the three fields that
// migration added to the claim: part of speech, usage labels, only-in-derived-terms. One-off; see
// scripts/backfillEntryUsageFields.mjs.
//
// WHY IT IS NEEDED. fingerprintOutcome now ends with those three fields, so a vote cast today
// confirming "noun" and a vote cast last month confirming the same word differ in fingerprint -
// the old one has no pos at all. Unrepaired, every word with an older vote reads as contested the
// moment someone votes again, and every decided word as dissented.
//
// WHY IT IS EXACT, NOT A GUESS. Before 0029 nothing could change a word's pos after it was created,
// so whatever the word resolves to now (override, else pin) is what every earlier voter saw, with
// no labels and the flag off. See extendLegacyEntryFingerprint.
//
// WHAT IT WRITES, AND ONLY THIS: contributions.resolved_value (the three keys added) and
// value_fingerprint (extended), and word_decisions.value_fingerprint (extended). It adds no votes,
// supersedes none, and never writes golden_record - so unlike backfillAuthoringVotes it is
// attributed to nobody: it completes what people already said rather than saying anything new.
//
// Idempotent. A row already carrying the new fields is not planned, so an interrupted run is
// finished by running it again.

import type pg from 'pg';
import { extendLegacyEntryFingerprint } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';

export interface UsageBackfillItem {
  kind: 'contribution' | 'decision';
  /** contribution_id, or the word_id of a word_decisions row. */
  id: string;
  wordId: string;
  pos: string | null;
  fingerprint: string;
}

export interface UsageBackfillPlan {
  planned: UsageBackfillItem[];
}

/** Finds every pre-0029 entry fingerprint, touching nothing. */
export async function planEntryUsageBackfill(client: Queryable): Promise<UsageBackfillPlan> {
  const rows = await client.query<{
    kind: 'contribution' | 'decision';
    id: string;
    word_id: string;
    pos: string | null;
    fingerprint: string;
  }>(
    `select 'contribution' as kind, n.contribution_id::text as id, n.word_id, n.value_fingerprint as fingerprint,
            coalesce(g.pos, c.pin ->> 'pos') as pos
       from contributions n
       join golden_record g on g.word_id = n.word_id
       left join upstream_citations c on c.word_id = n.word_id
      where n.axis = 'entry' and n.value_fingerprint is not null
     union all
     select 'decision', d.word_id, d.word_id, d.value_fingerprint, coalesce(g.pos, c.pin ->> 'pos')
       from word_decisions d
       join golden_record g on g.word_id = d.word_id
       left join upstream_citations c on c.word_id = d.word_id
      where d.axis = 'entry' and d.value_fingerprint is not null
      order by 1, 2`,
  );
  // Filtered here rather than in SQL: "is this a pre-0029 fingerprint" is a question about the
  // field layout, and only consensus.ts knows that.
  const planned = rows.rows
    .filter((r) => extendLegacyEntryFingerprint(r.fingerprint, r.pos) !== null)
    .map((r) => ({ kind: r.kind, id: r.id, wordId: r.word_id, pos: r.pos, fingerprint: r.fingerprint }));
  return { planned };
}

export interface UsageBackfillResult extends UsageBackfillPlan {
  written: number;
  /** Planned items this call did not reach, because `limit` stopped it. Zero means done. */
  remaining: number;
  failed: Array<UsageBackfillItem & { error: string }>;
}

/** Applies the plan, one row per transaction, at most `limit` of them - bounded and resumable for
 * the reason backfillAuthoringVotes gives (the caller may be an HTTP request). The fingerprint is
 * re-checked in the WHERE clause, so a row that changed since planning is left alone. */
export async function applyEntryUsageBackfill(
  pool: pg.Pool,
  plan: UsageBackfillPlan,
  limit = Number.POSITIVE_INFINITY,
): Promise<UsageBackfillResult> {
  const batch = plan.planned.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
  const result: UsageBackfillResult = { ...plan, written: 0, remaining: plan.planned.length - batch.length, failed: [] };

  for (const item of batch) {
    try {
      const extended = extendLegacyEntryFingerprint(item.fingerprint, item.pos) as string;
      // eslint-disable-next-line no-await-in-loop
      const updated = await withTransaction(pool, (client) =>
        item.kind === 'contribution'
          ? client.query(
              `update contributions
                  set value_fingerprint = $1,
                      resolved_value = resolved_value || jsonb_build_object(
                        'pos', $2::text, 'usageLabels', '[]'::jsonb, 'onlyInDerivedTerms', false)
                where contribution_id = $3::uuid and value_fingerprint = $4`,
              [extended, item.pos, item.id, item.fingerprint],
            )
          : client.query(
              `update word_decisions set value_fingerprint = $1
                where word_id = $2 and axis = 'entry' and value_fingerprint = $3`,
              [extended, item.id, item.fingerprint],
            ),
      );
      // Zero rows means the fingerprint moved since planning - someone voted again - which is not
      // a failure, and not a write either.
      if (updated.rowCount) result.written += 1;
    } catch (err) {
      result.failed.push({ ...item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

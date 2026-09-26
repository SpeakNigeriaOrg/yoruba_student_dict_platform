// handlers/backfillEntryUsageFields.ts
//
// Brings every stored entry-axis vote and decision up to the current claim layout. Two repairs,
// both one-off, both idempotent; see scripts/backfillEntryUsageFields.mjs.
//
// 1. EXTEND (after 0029). fingerprintOutcome ends with part of speech, usage labels and the
//    only-in-derived-terms flag, so a vote cast before 0029 - which has no pos at all - differs
//    from a new vote confirming the same word. Unrepaired, every word with an older vote reads as
//    contested the moment someone votes again, and every decided word as dissented. Exact, not a
//    guess: before 0029 nothing could change a word's pos, so what it resolves to now is what every
//    earlier voter saw, with no labels and the flag its part of speech implies.
//
// 2. AFFIX FLAG (after 0030). 0030 turned the flag ON for every affix - it is never a standalone
//    word - where 0029 had forced it off. A vote that asserted an affix pos under 0029 therefore
//    says flag=off, and a new vote on the same word says on. Only the flag changes: it is set on
//    the vote's own stored outcome (the pos IT asserted) and recomputed from that; a decision, which
//    stores only its fingerprint, has just that one field rewritten (setDerivedOnlyInEntryFingerprint).
//
// WHAT IT WRITES, AND ONLY THIS: contributions.resolved_value / value_fingerprint and
// word_decisions.value_fingerprint. It adds no votes, supersedes none, and never writes
// golden_record - so it is attributed to nobody: it completes what people already said.
//
// Idempotent. A row already in the current layout is not planned, so an interrupted run is
// finished by running it again.

import type pg from 'pg';
import {
  extendLegacyEntryFingerprint,
  fingerprintOutcome,
  isAffixPartOfSpeech,
  resolveOnlyInDerivedTerms,
  setDerivedOnlyInEntryFingerprint,
  type EntryOutcome,
} from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';

export interface UsageBackfillItem {
  kind: 'contribution' | 'decision';
  repair: 'extend' | 'affix_flag';
  /** contribution_id, or the word_id of a word_decisions row. */
  id: string;
  wordId: string;
  /** For 'extend', the word's resolved pos; for 'affix_flag', the pos the row asserts. */
  pos: string | null;
  fingerprint: string;
  newFingerprint: string;
}

export interface UsageBackfillPlan {
  planned: UsageBackfillItem[];
}

/** Finds every row either repair applies to, touching nothing. */
export async function planEntryUsageBackfill(client: Queryable): Promise<UsageBackfillPlan> {
  const rows = await client.query<{
    kind: 'contribution' | 'decision';
    id: string;
    word_id: string;
    word_pos: string | null;
    fingerprint: string;
    resolved_value: EntryOutcome | null;
  }>(
    `select 'contribution' as kind, n.contribution_id::text as id, n.word_id, n.value_fingerprint as fingerprint,
            coalesce(g.pos, c.pin ->> 'pos') as word_pos, n.resolved_value
       from contributions n
       join golden_record g on g.word_id = n.word_id
       left join upstream_citations c on c.word_id = n.word_id
      where n.axis = 'entry' and n.value_fingerprint is not null
     union all
     select 'decision', d.word_id, d.word_id, d.value_fingerprint, coalesce(g.pos, c.pin ->> 'pos'), null
       from word_decisions d
       join golden_record g on g.word_id = d.word_id
       left join upstream_citations c on c.word_id = d.word_id
      where d.axis = 'entry' and d.value_fingerprint is not null
      order by 1, 2`,
  );

  // Decided here rather than in SQL: which layout a fingerprint has is a question only consensus.ts
  // can answer.
  const planned: UsageBackfillItem[] = [];
  for (const r of rows.rows) {
    const base = { kind: r.kind, id: r.id, wordId: r.word_id, fingerprint: r.fingerprint };
    const extended = extendLegacyEntryFingerprint(r.fingerprint, r.word_pos);
    if (extended !== null) {
      planned.push({ ...base, repair: 'extend', pos: r.word_pos, newFingerprint: extended });
      continue;
    }
    if (r.kind === 'contribution') {
      const o = r.resolved_value;
      if (!o || o.pos === undefined || !isAffixPartOfSpeech(o.pos) || o.onlyInDerivedTerms === true) continue;
      const fixed = fingerprintOutcome({ ...o, onlyInDerivedTerms: true });
      if (fixed !== r.fingerprint) planned.push({ ...base, repair: 'affix_flag', pos: o.pos, newFingerprint: fixed });
    } else if (isAffixPartOfSpeech(r.word_pos)) {
      const fixed = setDerivedOnlyInEntryFingerprint(r.fingerprint, true);
      if (fixed !== null && fixed !== r.fingerprint) {
        planned.push({ ...base, repair: 'affix_flag', pos: r.word_pos, newFingerprint: fixed });
      }
    }
  }
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
      // What the stored outcome gains: the three fields for 'extend', just the flag for 'affix_flag'.
      const patch =
        item.repair === 'extend'
          ? { pos: item.pos, usageLabels: [], onlyInDerivedTerms: resolveOnlyInDerivedTerms(item.pos, false) }
          : { onlyInDerivedTerms: true };
      // eslint-disable-next-line no-await-in-loop
      const updated = await withTransaction(pool, (client) =>
        item.kind === 'contribution'
          ? client.query(
              `update contributions
                  set value_fingerprint = $1, resolved_value = resolved_value || $2::jsonb
                where contribution_id = $3::uuid and value_fingerprint = $4`,
              [item.newFingerprint, JSON.stringify(patch), item.id, item.fingerprint],
            )
          : client.query(
              `update word_decisions set value_fingerprint = $1
                where word_id = $2 and axis = 'entry' and value_fingerprint = $3`,
              [item.newFingerprint, item.id, item.fingerprint],
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

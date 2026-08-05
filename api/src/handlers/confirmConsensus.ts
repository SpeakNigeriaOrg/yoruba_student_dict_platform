// handlers/confirmConsensus.ts
//
// Backs POST /consensus/confirm - curator-only. Promotes the volunteer
// consensus on one or many (word, axis) pairs to the golden record.
//
// This is the bulk path that makes the model worth having: where the evidence
// agrees, a curator ratifies many words at once instead of opening each.
//
// EVERY ITEM IS RE-VERIFIED SERVER-SIDE. The caller sends only which
// (word, axis) pairs to confirm and which fingerprint it believed was winning;
// this handler recomputes the consensus from the contributions table and
// refuses anything that has since changed. That mirrors applyEntryDecision's
// adopt_kaikki check, which re-derives the adoption target rather than trusting
// a client-supplied spelling - for the same reason. A stale bulk-confirm list
// must never write a decision nobody voted for, and a bulk action is precisely
// where a stale list is likely: the curator loaded the queue minutes ago and
// contributions have kept arriving.

import type pg from 'pg';
import { summarizeConsensus, type ContributionOutcome, type ContributionRecord } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import { applyEntryOutcomeInTransaction } from './applyEntryDecision.js';
import { applyEtymologyOutcomeInTransaction } from './applyEtymologyDecision.js';
import type { DecisionAxis } from '../reviewShared.js';

export interface ConfirmConsensusItem {
  wordId: string;
  axis: DecisionAxis;
  /** The fingerprint the curator saw winning. Optional for a single explicit
   * confirmation, REQUIRED in spirit for bulk: supplying it turns "confirm
   * whatever is winning now" into "confirm the thing I actually looked at". */
  expectedFingerprint?: string;
  note?: string;
}

export interface ConfirmConsensusInput {
  items: ConfirmConsensusItem[];
}

export type ConfirmSkipReason =
  | 'no_contributions'
  | 'no_clear_winner'
  | 'changed_since_you_looked'
  | 'already_golden_and_unchanged';

export interface ConfirmConsensusResult {
  confirmed: Array<{ wordId: string; axis: DecisionAxis; fingerprint: string; agreementCount: number }>;
  skipped: Array<{ wordId: string; axis: DecisionAxis; reason: ConfirmSkipReason; detail?: string }>;
}

/** Partial success is deliberate: a bulk confirm of 40 words should not fail
 * wholesale because one of them gained a dissenting vote a minute ago. Each
 * item is applied in its own transaction and reported individually, so the
 * curator sees exactly what landed and what needs a second look. */
export async function confirmConsensus(
  pool: pg.Pool,
  input: ConfirmConsensusInput,
  confirmedBy: string,
): Promise<ConfirmConsensusResult> {
  const result: ConfirmConsensusResult = { confirmed: [], skipped: [] };

  for (const item of input.items) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await withTransaction(pool, (client) => confirmOne(client, item, confirmedBy));
    if (outcome.ok) {
      result.confirmed.push({
        wordId: item.wordId,
        axis: item.axis,
        fingerprint: outcome.fingerprint,
        agreementCount: outcome.agreementCount,
      });
    } else {
      result.skipped.push({ wordId: item.wordId, axis: item.axis, reason: outcome.reason, detail: outcome.detail });
    }
  }

  return result;
}

type ConfirmOneResult =
  | { ok: true; fingerprint: string; agreementCount: number }
  | { ok: false; reason: ConfirmSkipReason; detail?: string };

async function confirmOne(client: Queryable, item: ConfirmConsensusItem, confirmedBy: string): Promise<ConfirmOneResult> {
  // `for update` on the contributions being counted, so a submission arriving
  // mid-confirmation blocks rather than racing - the same row-locking rationale
  // approveContribution already uses.
  const rows = await client.query<{
    contribution_id: string;
    submitted_by: string;
    submitted_at: string;
    value_fingerprint: string;
    resolved_value: ContributionOutcome;
  }>(
    `select contribution_id, submitted_by, submitted_at, value_fingerprint, resolved_value
     from contributions
     where word_id = $1 and axis = $2 and status = 'active' and value_fingerprint is not null
     for update`,
    [item.wordId, item.axis],
  );

  if (rows.rowCount === 0) return { ok: false, reason: 'no_contributions' };

  const records: ContributionRecord[] = rows.rows.map((r) => ({
    contributionId: r.contribution_id,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    valueFingerprint: r.value_fingerprint,
    resolvedValue: r.resolved_value,
  }));

  const existing = await client.query<{ value_fingerprint: string | null }>(
    'select value_fingerprint from word_decisions where word_id = $1 and axis = $2',
    [item.wordId, item.axis],
  );

  // Summarized WITHOUT the golden reference: the question here is "what does
  // the evidence say", not "does it dissent". Passing the decision in would
  // bucket the group as golden/dissent and hide the winner.
  const summary = summarizeConsensus(records, null);

  if (!summary.winner) {
    return {
      ok: false,
      reason: 'no_clear_winner',
      detail: summary.isTied ? 'the top claims are tied' : 'no claims',
    };
  }

  if (item.expectedFingerprint && item.expectedFingerprint !== summary.winner.fingerprint) {
    return {
      ok: false,
      reason: 'changed_since_you_looked',
      detail: `now winning: ${summary.winner.count} vote(s) for a different outcome`,
    };
  }

  const already = existing.rows[0];
  if (already && already.value_fingerprint === summary.winner.fingerprint) {
    return { ok: false, reason: 'already_golden_and_unchanged' };
  }

  const outcome = summary.winner.outcome;
  const note = item.note ?? `Confirmed from ${summary.winner.count} agreeing contribution(s).`;

  if (outcome.kind === 'entry') {
    await applyEntryOutcomeInTransaction(client, item.wordId, outcome, note, confirmedBy);
  } else {
    await applyEtymologyOutcomeInTransaction(client, item.wordId, outcome, note, confirmedBy);
  }

  return { ok: true, fingerprint: summary.winner.fingerprint, agreementCount: summary.winner.count };
}

// handlers/backfillBorrowingFromWiktionary.ts
//
// Gives existing cited words the loanword answer their Wiktionary entry already states, and brings
// the etymology votes and decisions made before 0032 into line with it. One-off; see
// scripts/backfillBorrowingFromWiktionary.mjs.
//
// WHY. 0032 added borrowing to the record and to the etymology claim, and the first backfill
// (backfillEntryUsageFields) completed every earlier etymology vote as "not borrowed". For a word
// like búrẹ́dì, which Wiktionary says is borrowed from English "bread", that made the older votes
// assert something nobody said - and a reviewer now confirming Wiktionary's answer read as a
// conflict with them, or as dissent on a decided word.
//
// THE RULE, and why it is the same one pos follows. A vote cast before 0032 said nothing about
// borrowing. For part of speech (0029) such a vote was completed with the word's RESOLVED value -
// ours if we had one, else the cited entry's - on the ground that confirming a cited word endorses
// what it cites. Borrowing follows suit: where our record is silent and the cited entry marks the
// word borrowed, the record takes Wiktionary's answer and the earlier votes are completed with it.
//
// WHAT IT TOUCHES, and only for those words:
//   - golden_record.borrowed_from / borrowed_term, only where both are null;
//   - etymology contributions submitted BEFORE \`before\` (the 0032 deploy) whose stored outcome says
//     not borrowed - every one of those is the first backfill's completion, never a person's answer;
//   - etymology word_decisions decided before \`before\`, the same way.
// A vote or decision made after the deploy is a real answer and is never rewritten.
//
// Idempotent: a word whose record is no longer silent is not planned.

import type pg from 'pg';
import {
  fingerprintOutcome,
  normalizeLoanLanguage,
  setBorrowingInEtymologyFingerprint,
  wiktionaryLoanTerm,
  type EtymologyOutcome,
} from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';

export interface BorrowingBackfillItem {
  wordId: string;
  displayText: string;
  borrowedFrom: string;
  borrowedTerm: string | null;
  /** How many earlier etymology votes / decisions on the word will be completed with it. */
  votes: number;
  decisions: number;
}

export interface BorrowingBackfillPlan {
  before: string;
  planned: BorrowingBackfillItem[];
}

export async function planBorrowingBackfill(client: Queryable, before: string): Promise<BorrowingBackfillPlan> {
  const { rows } = await client.query<{
    word_id: string;
    display_text: string;
    wik_from: string;
    wik_term: string | null;
    votes: string;
    decisions: string;
  }>(
    `select g.word_id, g.display_text, s.borrowed_from as wik_from, s.borrowed_term as wik_term,
            (select count(*) from contributions n
              where n.word_id = g.word_id and n.axis = 'etymology' and n.value_fingerprint is not null
                and n.submitted_at < $1 and coalesce(n.resolved_value ->> 'borrowedFrom', '') = '') as votes,
            (select count(*) from word_decisions d
              where d.word_id = g.word_id and d.axis = 'etymology' and d.value_fingerprint is not null
                and d.decided_at < $1) as decisions
       from golden_record g
       join upstream_citations c on c.word_id = g.word_id
       join kaikki_senses s on s.entry_id = c.entry_id
      where s.borrowed_from is not null and g.borrowed_from is null and g.borrowed_term is null
      order by g.word_id`,
    [before],
  );
  return {
    before,
    planned: rows.map((r) => ({
      wordId: r.word_id,
      displayText: r.display_text,
      // en-GB is English as far as the list goes - the same normalization the screen applies.
      borrowedFrom: normalizeLoanLanguage(r.wik_from),
      borrowedTerm: wiktionaryLoanTerm(r.wik_term),
      votes: Number(r.votes),
      decisions: Number(r.decisions),
    })),
  };
}

export interface BorrowingBackfillResult extends BorrowingBackfillPlan {
  written: number;
  failed: Array<BorrowingBackfillItem & { error: string }>;
}

/** One transaction per word: its record, its earlier votes and its earlier decision together. */
export async function applyBorrowingBackfill(pool: pg.Pool, plan: BorrowingBackfillPlan): Promise<BorrowingBackfillResult> {
  const result: BorrowingBackfillResult = { ...plan, written: 0, failed: [] };
  for (const item of plan.planned) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(pool, async (client) => {
        await client.query(
          `update golden_record set borrowed_from = $1, borrowed_term = $2
            where word_id = $3 and borrowed_from is null and borrowed_term is null`,
          [item.borrowedFrom, item.borrowedTerm, item.wordId],
        );

        const votes = await client.query<{ contribution_id: string; resolved_value: EtymologyOutcome }>(
          `select contribution_id, resolved_value from contributions
            where word_id = $1 and axis = 'etymology' and value_fingerprint is not null
              and submitted_at < $2 and coalesce(resolved_value ->> 'borrowedFrom', '') = ''`,
          [item.wordId, plan.before],
        );
        for (const v of votes.rows) {
          const outcome: EtymologyOutcome = { ...v.resolved_value, borrowedFrom: item.borrowedFrom, borrowedTerm: item.borrowedTerm };
          await client.query(
            `update contributions set resolved_value = $1, value_fingerprint = $2 where contribution_id = $3`,
            [outcome, fingerprintOutcome(outcome), v.contribution_id],
          );
        }

        const decision = await client.query<{ value_fingerprint: string }>(
          `select value_fingerprint from word_decisions
            where word_id = $1 and axis = 'etymology' and value_fingerprint is not null and decided_at < $2`,
          [item.wordId, plan.before],
        );
        const fp = decision.rows[0]?.value_fingerprint;
        const rewritten = fp ? setBorrowingInEtymologyFingerprint(fp, item.borrowedFrom, item.borrowedTerm) : null;
        if (fp && rewritten) {
          await client.query(
            `update word_decisions set value_fingerprint = $1 where word_id = $2 and axis = 'etymology' and value_fingerprint = $3`,
            [rewritten, item.wordId, fp],
          );
        }
      });
      result.written += 1;
    } catch (err) {
      result.failed.push({ ...item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// handlers/authoringVote.ts
//
// A curator who authors an entry casts one ordinary vote for what they wrote.
//
// THE GAP THIS CLOSES. Add Word and Add Phrase wrote golden_record and nothing
// else: no word_decisions row, and no contributions row. But listConsensus
// builds its GoldenReference solely from word_decisions, so a curator-authored
// word had no golden reference at all - and therefore:
//
//   - dissentsFromGolden could never fire. A volunteer contradicting a
//     curator's spelling was not dissent, because as far as consensus was
//     concerned nobody had ever said anything.
//   - two agreeing volunteers reached bucket 'ready', i.e. the BULK-confirm
//     queue, looking uncontested.
//   - a curator bulk-confirming then overwrote the curator-authored value in
//     one click with no sign a conflict existed. Not an auto-override - nothing
//     here applies itself - but a silent one, which reads as agreement.
//
// So the author's claim is recorded as evidence, the same kind every volunteer
// submits. It counts toward AGREEMENT_THRESHOLD like any other vote: curator
// plus one agreeing volunteer is 'ready', and a single disagreeing volunteer
// makes the word 'contested' and jumps it up the queue, which is the outcome
// that was being missed.
//
// NOT a word_decisions row. That would mark the axis decided and take the word
// out of review, claiming the curator had reviewed what they had merely typed.
// A vote says "this is my answer"; a decision says "this question is settled",
// and authoring is only ever the first of those.
//
// Composed into the CREATE transaction rather than run after it, so a word can
// never exist with its author's vote missing. It is deliberately absent from
// the *InTransaction entry points: approveContribution composes those to apply
// a VOLUNTEER's proposal, and the approving curator did not author that content.

import type { Queryable } from '../db.js';
import { submitContributionInTransaction } from './submitContribution.js';

/** Casts the author's vote on both axes their form actually answered.
 *
 * `keep_ours` + `confirm` resolves, in submitContribution, against the record
 * as it stands inside this transaction - which is precisely what was just
 * written. So the frozen outcome is the author's own content, arrived at by the
 * same code path a volunteer's agreement would take, rather than a second
 * construction of it here that could drift from the first. */
/** The two submissions an authoring vote is made of.
 *
 * Exported because backfillAuthoringVotes.ts casts the same vote for words created before this
 * existed. Shared constants rather than two constructions of the same literal, so the backfilled
 * rows cannot come to mean something different from the live ones. */
export const AUTHORING_ENTRY_VOTE = { action: 'keep_ours', definitionAction: 'confirm' } as const;
export const AUTHORING_ETYMOLOGY_VOTE = { componentsAction: 'confirm_existing' } as const;
export const AUTHORING_NOTE = 'Authored on the add-entry form.';

export async function recordAuthoringVote(
  client: Queryable,
  wordId: string,
  authoredBy: string,
  opts: { hasComponents: boolean },
): Promise<void> {
  await submitContributionInTransaction(
    client,
    {
      axis: 'entry',
      wordId,
      proposedValue: { ...AUTHORING_ENTRY_VOTE },
      note: AUTHORING_NOTE,
    },
    authoredBy,
  );

  // Only when they actually recorded a decomposition.
  //
  // Silence is not a vote for 'atomic'. The components section on Add Word is optional and
  // collapsed, and its own rule is that opening it and picking nothing is the same as never
  // opening it - so casting confirm_atomic for every word created without it would put a claim in
  // the author's mouth that the form never asked them to make, on the great majority of words.
  // A phrase always has components, so a phrase always votes here.
  if (!opts.hasComponents) return;
  await submitContributionInTransaction(
    client,
    {
      axis: 'etymology',
      wordId,
      proposedValue: { ...AUTHORING_ETYMOLOGY_VOTE },
      note: AUTHORING_NOTE,
    },
    authoredBy,
  );
}

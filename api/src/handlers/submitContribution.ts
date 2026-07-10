// handlers/submitContribution.ts
//
// Backs POST /contributions - any authenticated user proposes a decision
// on an axis of an existing word, or (axis: 'new_entry') a brand-new
// word/phrase (curator-gated authoring means a volunteer can only ever
// propose one of these, never insert directly - see createWord.ts/
// createPhrase.ts for the curator-direct path). Never applies anything -
// purely records a pending row for a curator to review via
// approveContribution.ts.

import type { Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';
import type { ApplyDefinitionDecisionInput } from './applyDefinitionDecision.js';
import type { ApplyEtymologyDecisionInput } from './applyEtymologyDecision.js';
import type { ApplySpellingDecisionInput } from './applySpellingDecision.js';

export interface NewEntryProposedValue {
  proposedWordId: string;
  displayText: string;
  syllables: string[];
  type: 'word' | 'phrase';
  /** Only meaningful (and required) for type: 'phrase' - must reference
   * already-approved golden_record word_ids, never another still-pending
   * draft, exactly like createPhrase.ts (checked at approval time, not
   * here - between submission and approval nothing about an
   * already-existing word's existence changes). */
  components?: string[];
}

export type SubmitContributionInput =
  | { axis: 'spelling'; wordId: string; proposedValue: ApplySpellingDecisionInput; note?: string }
  | { axis: 'definition'; wordId: string; proposedValue: ApplyDefinitionDecisionInput; note?: string }
  | { axis: 'etymology'; wordId: string; proposedValue: ApplyEtymologyDecisionInput; note?: string }
  | { axis: 'new_entry'; proposedValue: NewEntryProposedValue; note?: string };

export interface SubmittedContribution {
  contributionId: string;
}

export async function submitContribution(
  db: Queryable,
  input: SubmitContributionInput,
  submittedBy: string,
): Promise<SubmittedContribution> {
  if (input.axis !== 'new_entry') {
    const existing = await db.query('select 1 from golden_record where word_id = $1', [input.wordId]);
    if ((existing.rowCount ?? 0) === 0) {
      throw new WordNotFoundError(input.wordId);
    }
  }

  const wordId = input.axis === 'new_entry' ? null : input.wordId;
  const result = await db.query<{ contribution_id: string }>(
    `insert into contributions (word_id, axis, proposed_value, note, submitted_by)
     values ($1, $2, $3, $4, $5)
     returning contribution_id`,
    [wordId, input.axis, input.proposedValue, input.note ?? null, submittedBy],
  );
  return { contributionId: result.rows[0].contribution_id };
}

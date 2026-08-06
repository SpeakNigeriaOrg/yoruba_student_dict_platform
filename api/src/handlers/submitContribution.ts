// handlers/submitContribution.ts
//
// Backs POST /contributions - any authenticated user contributes EVIDENCE
// about an existing word, or (axis: 'new_entry') proposes a brand-new
// word/phrase. Never applies anything to golden_record; a curator's
// confirmation does that (confirmConsensus.ts), or for 'new_entry' their
// per-contribution approval (approveContribution.ts).
//
// Two things happen here beyond the insert, and both are load-bearing:
//
//   1. THE OUTCOME IS RESOLVED AND FROZEN. The action-shaped submission is
//      reduced to the content state it asserts, against golden_record as it
//      stands right now - the state the contributor was looking at - and
//      stored alongside the raw proposal. It is never recomputed.
//
//      `keep_ours` means "whatever it says now". Resolving it later, against a
//      record that has since changed, would retroactively put words in a
//      volunteer's mouth. Same discipline as 0006's recorded_display_text on
//      recordings; see shared/src/consensus.ts for the full argument.
//
//   2. THE SUBMITTER'S OWN PRIOR VOTE IS SUPERSEDED, not overwritten. One
//      active vote per person per axis is enforced by a partial unique index
//      (0013), so changing your mind marks the old row 'superseded' and inserts
//      a new one. The old row survives, because what someone believed and when
//      is part of the record.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import {
  fingerprintOutcome,
  resolveEntryOutcome,
  resolveEtymologyOutcome,
  type ContributionOutcome,
} from '@yoruba-student-dict-platform/shared';
import { WordNotFoundError } from './errors.js';
import type { ApplyEntryDecisionInput } from './applyEntryDecision.js';
import type { ApplyEtymologyDecisionInput } from './applyEtymologyDecision.js';
import type { UpstreamCitationInput } from './upstreamCitations.js';

export interface NewEntryProposedValue {
  proposedWordId: string;
  displayText: string;
  syllables: string[];
  type: 'word' | 'phrase';
  /** Which Wiktionary etymology the proposed WORD is - captured when the
   * volunteer picked it from the Kaikki search, so approval creates a cited
   * word rather than one that has to be matched back by spelling later.
   *
   * Optional in the type, unlike CreateWordInput.citation, because this value is
   * read back out of `contributions.proposed_value` as a jsonb cast - the
   * compiler cannot enforce anything about it, so pretending otherwise would be
   * a false guarantee. Enforced for real at the two places that matter: the HTTP
   * edge that accepts it (parseNewEntryInput) and the approval that consumes it
   * (approveNewEntry). Absent for type 'phrase', which is exempt by nature. */
  citation?: UpstreamCitationInput;
  /** The word's meaning in English.
   *
   * Without this, approveNewEntry created the word with definition null - a requested word
   * arriving meaningless, which for a word nobody in the dictionary has seen before is the
   * one thing a curator most needs. Populated from the cited etymology's first gloss when the
   * request came from a Kaikki pick, or from what the requester typed when it did not. */
  definition?: string;
  /** Only meaningful (and required) for type: 'phrase' - must reference
   * already-approved golden_record word_ids, never another still-pending
   * draft, exactly like createPhrase.ts (checked at approval time, not
   * here - between submission and approval nothing about an
   * already-existing word's existence changes). */
  components?: string[];
}

export type SubmitContributionInput =
  | { axis: 'entry'; wordId: string; proposedValue: ApplyEntryDecisionInput; note?: string }
  | { axis: 'etymology'; wordId: string; proposedValue: ApplyEtymologyDecisionInput; note?: string }
  | { axis: 'new_entry'; proposedValue: NewEntryProposedValue; note?: string };

export interface SubmittedContribution {
  contributionId: string;
  /** Whether this replaced the submitter's own earlier vote on the same axis.
   * Surfaced so the UI can say "your earlier answer was replaced" rather than
   * silently appearing to do nothing. */
  supersededPrior: boolean;
}

/** The content state the contributor is looking at. Read inside the same
 * transaction as the insert, so the frozen outcome can't be resolved against a
 * record that changed underneath it. */
async function loadObservedState(
  client: Queryable,
  wordId: string,
): Promise<{
  displayText: string;
  syllables: string[];
  definition: string | null;
  citedEntryId: string | null;
  components: string[];
}> {
  // Left-joined rather than a second query: the cited etymology is part of the
  // state a contributor is looking at, so it must be read in the SAME snapshot
  // as the rest of it. Null covers both "no citation row" and "explicitly
  // exempt", which are the same thing from a contributor's point of view - there
  // is no etymology to agree or disagree about.
  const word = await client.query<{
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_id: string | null;
  }>(
    `select g.display_text, g.syllables, g.definition, c.entry_id
     from golden_record g
     left join upstream_citations c on c.word_id = g.word_id
     where g.word_id = $1`,
    [wordId],
  );
  const row = word.rows[0];
  if (!row) throw new WordNotFoundError(wordId);

  const components = await client.query<{ component_word_id: string }>(
    'select component_word_id from golden_record_components where word_id = $1 order by component_position',
    [wordId],
  );

  return {
    displayText: row.display_text,
    syllables: row.syllables,
    definition: row.definition,
    citedEntryId: row.entry_id,
    components: components.rows.map((r) => r.component_word_id),
  };
}

/** Narrowed to the two consensus axes: 'new_entry' has no existing content to
 * resolve against and takes no part in consensus, so it never reaches here. */
function resolveOutcome(
  input: Extract<SubmitContributionInput, { axis: 'entry' | 'etymology' }>,
  observed: Awaited<ReturnType<typeof loadObservedState>>,
): ContributionOutcome {
  if (input.axis === 'entry') {
    return resolveEntryOutcome(
      {
        displayText: observed.displayText,
        syllables: observed.syllables,
        definition: observed.definition,
        citedEntryId: observed.citedEntryId,
      },
      input.proposedValue,
    );
  }
  return resolveEtymologyOutcome({ components: observed.components }, input.proposedValue);
}

/** Transactional because the supersede and the insert must land together: on a
 * bare pool they are two round trips, and a concurrent submission from the same
 * person could interleave between them and trip the one-active-vote index.
 * Reading the observed state inside the same transaction also guarantees the
 * frozen outcome describes a record that could not change underneath it. */
export async function submitContribution(
  pool: pg.Pool,
  input: SubmitContributionInput,
  submittedBy: string,
): Promise<SubmittedContribution> {
  return withTransaction(pool, (client) => submitContributionInTransaction(client, input, submittedBy));
}

export async function submitContributionInTransaction(
  db: Queryable,
  input: SubmitContributionInput,
  submittedBy: string,
): Promise<SubmittedContribution> {
  // A proposed new word has no existing content to resolve an outcome against -
  // it IS the content - so it carries no fingerprint and takes no part in
  // consensus. A curator approves it individually.
  if (input.axis === 'new_entry') {
    const result = await db.query<{ contribution_id: string }>(
      `insert into contributions (word_id, axis, proposed_value, note, submitted_by)
       values (null, $1, $2, $3, $4)
       returning contribution_id`,
      [input.axis, input.proposedValue, input.note ?? null, submittedBy],
    );
    return { contributionId: result.rows[0].contribution_id, supersededPrior: false };
  }

  const observed = await loadObservedState(db, input.wordId);
  const outcome = resolveOutcome(input, observed);
  const fingerprint = fingerprintOutcome(outcome);

  // Two statements, deliberately - a data-modifying CTE would share one
  // snapshot with the insert, leaving the old row visible as 'active' to the
  // partial unique index and failing. See 0013's implementation note.
  const superseded = await db.query(
    `update contributions set status = 'superseded'
     where word_id = $1 and axis = $2 and submitted_by = $3 and status = 'active'`,
    [input.wordId, input.axis, submittedBy],
  );

  const result = await db.query<{ contribution_id: string }>(
    `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, note, submitted_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning contribution_id`,
    [input.wordId, input.axis, input.proposedValue, outcome, fingerprint, input.note ?? null, submittedBy],
  );

  return {
    contributionId: result.rows[0].contribution_id,
    supersededPrior: (superseded.rowCount ?? 0) > 0,
  };
}

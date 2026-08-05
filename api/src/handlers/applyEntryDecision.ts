// handlers/applyEntryDecision.ts
//
// Backs POST /decisions/entry - a curator's decision on a word's written
// form AND its meaning, as one indivisible act. Replaces the separate
// applySpellingDecision.ts/applyDefinitionDecision.ts.
//
// Atomicity is enforced HERE, not just in the UI: a request must carry both
// a spelling `action` and a `definitionAction`. That is the whole point of
// the merge - a word must never be left with its form blessed and its sense
// unreviewed, and a server that accepted half a decision would let any
// client (or a future screen, or a replayed contribution) recreate exactly
// the state 0011_merge_entry_axis.sql just abolished.
//
// The syllable-split sub-check stays optional: it only has an answer when
// the manual and programmatic splits actually disagree, so requiring it
// would make most entries unsubmittable.
//
// 'adopt_kaikki' still verifies newDisplayText server-side against ingest/'s
// Postgres-backed Kaikki data rather than trusting the client, reusing
// diagnoseEntry's own adoptionTarget computation.

import type pg from 'pg';
import {
  diagnoseEntry,
  fingerprintOutcome,
  orthographyInsensitiveForm,
  resolveEntryOutcome,
  syllabifyWord,
  type EntryOutcome,
  type KaikkiLexicon,
} from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { WordNotFoundError } from './errors.js';

export interface ApplyEntryDecisionInput {
  /** The written-form half. Required - see the module comment. */
  action?: 'keep_ours' | 'select_candidate' | 'adopt_kaikki';
  candidateForm?: string;
  /** Required when action is 'adopt_kaikki'. */
  newDisplayText?: string;
  /** Optional sub-check: only meaningful on a manual/programmatic mismatch. */
  syllableAction?: 'keep_manual' | 'accept_programmatic';
  syllableNote?: string;
  /** The meaning half. Required - see the module comment. */
  definitionAction?: 'confirm' | 'custom';
  definitionText?: string;
  /** Which Kaikki record's glosses this definition is sourced from - lets a
   * curator override resolveDefinitionSource's automatic choice (e.g.
   * redirecting away from a cross-reference record, or picking an entirely
   * different entry via manual search). Read back by getEntryReview.ts's
   * loadAxisOverride. */
  definitionSourceForm?: string;
  note?: string;
}

/** Thrown when a request carries only one half of the entry decision. Names
 * the missing half rather than saying "invalid input", because the whole
 * class of mistake here is a caller that still thinks of spelling and
 * definition as separate submissions. */
export class IncompleteEntryDecisionError extends Error {
  constructor(missing: 'action' | 'definitionAction') {
    super(
      missing === 'action'
        ? "action is required: an entry decision covers spelling and definition together, and this request has no spelling decision"
        : "definitionAction is required: an entry decision covers spelling and definition together, and this request has no definition decision",
    );
    this.name = 'IncompleteEntryDecisionError';
  }
}

export class NewDisplayTextRequiredError extends Error {
  constructor() {
    super("newDisplayText is required when action is 'adopt_kaikki'");
    this.name = 'NewDisplayTextRequiredError';
  }
}

export class MissingDefinitionTextError extends Error {
  constructor() {
    super("definitionText is required when definitionAction is 'custom'");
    this.name = 'MissingDefinitionTextError';
  }
}

export class KaikkiVerificationMismatchError extends Error {
  constructor(supplied: string, expected: string | undefined) {
    super(
      expected
        ? `newDisplayText '${supplied}' does not match what Kaikki data says this word should adopt ('${expected}')`
        : `newDisplayText '${supplied}' was supplied, but this word no longer resolves to any Kaikki sense worth adopting`,
    );
    this.name = 'KaikkiVerificationMismatchError';
  }
}

export function validateEntryDecisionInput(input: ApplyEntryDecisionInput): void {
  if (!input.action) throw new IncompleteEntryDecisionError('action');
  if (!input.definitionAction) throw new IncompleteEntryDecisionError('definitionAction');
  if (input.action === 'adopt_kaikki' && !input.newDisplayText) throw new NewDisplayTextRequiredError();
  if (input.definitionAction === 'custom' && !input.definitionText) throw new MissingDefinitionTextError();
}

export async function applyEntryDecision(
  pool: pg.Pool,
  wordId: string,
  input: ApplyEntryDecisionInput,
  decidedBy: string,
): Promise<void> {
  validateEntryDecisionInput(input);
  await withTransaction(pool, (client) => applyEntryDecisionInTransaction(client, wordId, input, decidedBy));
}

/** Exported so approveContribution.ts can compose this into its own single
 * transaction, rather than calling applyEntryDecision (which would open a
 * second, separate one). Callers reaching this directly are responsible for
 * having run validateEntryDecisionInput - approveContribution does, so a
 * contribution stored before the merge can't apply as half a decision. */
export async function applyEntryDecisionInTransaction(
  client: Queryable,
  wordId: string,
  input: ApplyEntryDecisionInput,
  decidedBy: string,
): Promise<void> {
  // definition is read alongside the rest so the outcome can be fingerprinted
  // below against the state observed before any of this handler's writes.
  const existing = await client.query<{
    display_text: string;
    syllables: string[];
    entry_type: string | null;
    definition: string | null;
  }>('select display_text, syllables, entry_type, definition from golden_record where word_id = $1', [wordId]);
  const currentRow = existing.rows[0];
  if (!currentRow) {
    throw new WordNotFoundError(wordId);
  }

  // The syllable split is checked against the spelling this word is
  // BECOMING (if adopt_kaikki is happening in this same decision), not the
  // one currently on record - matches resolveEffectiveDisplayText's
  // rationale in shared/src/syllableSplit.ts, inlined because this handler
  // has newDisplayText directly rather than a full diagnoseEntry result.
  let effectiveDisplayText = currentRow.display_text;

  if (input.action === 'adopt_kaikki' && input.newDisplayText) {
    const key = orthographyInsensitiveForm(currentRow.display_text);
    const senses = await loadKaikkiSensesForKey(client, key);
    const lexicon: KaikkiLexicon = senses.length > 0 ? { [key]: senses } : {};
    const vocabEntry = {
      displayText: currentRow.display_text,
      syllables: currentRow.syllables,
      ...(currentRow.entry_type === 'phrase' ? { type: 'phrase' as const } : {}),
    };
    const diagnosis = diagnoseEntry(wordId, vocabEntry, lexicon);
    if (diagnosis.adoptionTarget !== input.newDisplayText) {
      throw new KaikkiVerificationMismatchError(input.newDisplayText, diagnosis.adoptionTarget);
    }

    effectiveDisplayText = input.newDisplayText;
    await client.query('update golden_record set display_text = $1, updated_at = now(), updated_by = $2 where word_id = $3', [
      input.newDisplayText,
      decidedBy,
      wordId,
    ]);
  }

  if (input.syllableAction === 'accept_programmatic') {
    const programmatic = syllabifyWord(effectiveDisplayText);
    await client.query('update golden_record set syllables = $1, updated_at = now(), updated_by = $2 where word_id = $3', [
      programmatic,
      decidedBy,
      wordId,
    ]);
  }

  if (input.definitionAction === 'custom') {
    await client.query('update golden_record set definition = $1, updated_at = now(), updated_by = $2 where word_id = $3', [
      input.definitionText,
      decidedBy,
      wordId,
    ]);
  }

  // One row, both halves. The field vocabulary is deliberately the flat
  // DiagnoseOverride shape shared/ already uses (and that the old local
  // tool's dictionary_overrides.json always used), so getEntryReview's
  // loadAxisOverride can hand it straight back to diagnoseEntry and
  // checkDefinition without translation.
  const decision = {
    action: input.action,
    candidateForm: input.candidateForm,
    syllableAction: input.syllableAction,
    syllableNote: input.syllableNote,
    definitionAction: input.definitionAction,
    definitionText: input.definitionText,
    definitionSourceForm: input.definitionSourceForm,
  };
  // Fingerprinted with the same function contributions use, so a later
  // contribution that disagrees with this decision can be detected by equality
  // rather than re-derivation. Resolved from the state observed BEFORE the
  // writes above, which by construction equals the state after them.
  const outcome = resolveEntryOutcome(
    { displayText: currentRow.display_text, syllables: currentRow.syllables, definition: currentRow.definition },
    input,
  );

  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by, value_fingerprint)
     values ($1, 'entry', $2, $3, $4, $5)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by,
       decided_at = now(), value_fingerprint = excluded.value_fingerprint`,
    [wordId, decision, input.note ?? null, decidedBy, fingerprintOutcome(outcome)],
  );
}

/** Writes a consensus OUTCOME as the golden decision.
 *
 * Distinct from applyEntryDecisionInTransaction, which takes an action-shaped
 * input, for two reasons:
 *
 *   1. No Kaikki verification. adopt_kaikki re-checks newDisplayText against
 *      ingest/'s data because a client must not be trusted to invent a
 *      spelling. A consensus spelling came from agreeing humans, not from a
 *      Kaikki suggestion, so that check would wrongly reject it.
 *   2. It writes content directly. keep_ours and select_candidate deliberately
 *      never touch display_text, so there is no action that expresses "make the
 *      record say exactly this".
 *
 * The recorded `decision` is deliberately the settled form - keep_ours plus
 * confirm - because after these writes the record DOES hold the agreed content,
 * and that is what getEntryReview's loadAxisOverride should replay. What
 * changed, and who claimed it, lives in the contributions, which are never
 * mutated. */
export async function applyEntryOutcomeInTransaction(
  client: Queryable,
  wordId: string,
  outcome: EntryOutcome,
  note: string | null,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query<{ display_text: string; syllables: string[]; definition: string | null }>(
    'select display_text, syllables, definition from golden_record where word_id = $1',
    [wordId],
  );
  const row = existing.rows[0];
  if (!row) throw new WordNotFoundError(wordId);

  const syllablesDiffer =
    row.syllables.length !== outcome.syllables.length || row.syllables.some((s, i) => s !== outcome.syllables[i]);

  if (row.display_text !== outcome.displayText || syllablesDiffer || row.definition !== outcome.definitionText) {
    await client.query(
      `update golden_record
       set display_text = $1, syllables = $2, definition = $3, updated_at = now(), updated_by = $4
       where word_id = $5`,
      [outcome.displayText, outcome.syllables, outcome.definitionText, decidedBy, wordId],
    );
  }

  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by, value_fingerprint)
     values ($1, 'entry', $2, $3, $4, $5)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by,
       decided_at = now(), value_fingerprint = excluded.value_fingerprint`,
    [wordId, { action: 'keep_ours', definitionAction: 'confirm' }, note, decidedBy, fingerprintOutcome(outcome)],
  );
}

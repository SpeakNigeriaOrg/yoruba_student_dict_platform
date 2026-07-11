// handlers/applySpellingDecision.ts
//
// Backs POST /decisions/spelling - a curator's direct decision on the
// spelling/tone axis (diagnoseEntry) AND its secondary syllable-split
// sub-check (checkSyllableSplit), bundled together the same way a single
// dictionary_overrides.json[wordId] entry carries both action/
// candidateForm and syllableAction/syllableNote as sibling fields.
//
// 'adopt_kaikki' requires the caller to supply newDisplayText directly,
// but this now verifies it server-side against ingest/'s Postgres-backed
// Kaikki data (kaikkiData.ts) rather than trusting it outright - reuses
// diagnoseEntry's own adoptionTarget computation (scoped to a single-entry
// lexicon for just this word) instead of a second implementation of
// "which Kaikki sense does this word match."

import type pg from 'pg';
import { diagnoseEntry, orthographyInsensitiveForm, syllabifyWord, type KaikkiLexicon } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { WordNotFoundError } from './errors.js';

export interface ApplySpellingDecisionInput {
  action?: 'keep_ours' | 'select_candidate' | 'adopt_kaikki';
  candidateForm?: string;
  /** Required when action is 'adopt_kaikki' - see the module-level comment. */
  newDisplayText?: string;
  syllableAction?: 'keep_manual' | 'accept_programmatic';
  syllableNote?: string;
  note?: string;
}

export class NoDecisionProvidedError extends Error {
  constructor() {
    super('at least one of action or syllableAction is required');
    this.name = 'NoDecisionProvidedError';
  }
}

export class NewDisplayTextRequiredError extends Error {
  constructor() {
    super("newDisplayText is required when action is 'adopt_kaikki'");
    this.name = 'NewDisplayTextRequiredError';
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

export async function applySpellingDecision(
  pool: pg.Pool,
  wordId: string,
  input: ApplySpellingDecisionInput,
  decidedBy: string,
): Promise<void> {
  if (!input.action && !input.syllableAction) {
    throw new NoDecisionProvidedError();
  }
  if (input.action === 'adopt_kaikki' && !input.newDisplayText) {
    throw new NewDisplayTextRequiredError();
  }

  await withTransaction(pool, (client) => applySpellingDecisionInTransaction(client, wordId, input, decidedBy));
}

/** Exported so approveContribution.ts can compose this into its own single
 * transaction, rather than calling applySpellingDecision (which would open
 * a second, separate transaction). */
export async function applySpellingDecisionInTransaction(
  client: Queryable,
  wordId: string,
  input: ApplySpellingDecisionInput,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query<{ display_text: string; syllables: string[]; entry_type: string | null }>(
    'select display_text, syllables, entry_type from golden_record where word_id = $1',
    [wordId],
  );
  const currentRow = existing.rows[0];
  if (!currentRow) {
    throw new WordNotFoundError(wordId);
  }

  // Checks the syllable split against the spelling this word is BECOMING
  // (if adopt_kaikki is happening in this same decision), not the one on
  // record right now - matches resolveEffectiveDisplayText's rationale in
  // shared/src/syllableSplit.ts exactly, just inlined here since this
  // handler already has newDisplayText directly rather than a full
  // diagnoseEntry result to extract adoptionTarget from.
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

  const decision = {
    action: input.action,
    candidateForm: input.candidateForm,
    syllableAction: input.syllableAction,
    syllableNote: input.syllableNote,
  };
  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by)
     values ($1, 'spelling', $2, $3, $4)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by, decided_at = now()`,
    [wordId, decision, input.note ?? null, decidedBy],
  );
}

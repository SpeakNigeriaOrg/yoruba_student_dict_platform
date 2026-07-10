// handlers/applySpellingDecision.ts
//
// Backs POST /decisions/spelling - a curator's direct decision on the
// spelling/tone axis (diagnoseEntry) AND its secondary syllable-split
// sub-check (checkSyllableSplit), bundled together the same way a single
// dictionary_overrides.json[wordId] entry carries both action/
// candidateForm and syllableAction/syllableNote as sibling fields.
//
// Known gap: 'adopt_kaikki' requires the caller to supply newDisplayText
// directly rather than this handler re-deriving it from the Kaikki
// lexicon itself (the way diagnoseEntry would). The client already runs
// diagnoseEntry against its own held copy of the lexicon to show the
// curator what "adopt Kaikki's spelling" means before they click it, so
// this trusts that computed value rather than re-verifying it server-side
// - the Function app has no established way to load the (multi-MB) Kaikki
// lexicon at runtime yet. Revisit once that's decided; until then this is
// no less trusting of the client than createWord/createPhrase already are
// for displayText/syllables in general.

import type pg from 'pg';
import { syllabifyWord } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
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

  await withTransaction(pool, (client) => applyInTransaction(client, wordId, input, decidedBy));
}

async function applyInTransaction(
  client: Queryable,
  wordId: string,
  input: ApplySpellingDecisionInput,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query<{ display_text: string }>(
    'select display_text from golden_record where word_id = $1',
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

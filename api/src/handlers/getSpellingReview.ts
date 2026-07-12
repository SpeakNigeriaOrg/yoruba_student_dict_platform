// handlers/getSpellingReview.ts
//
// Backs GET /words/{wordId}/spelling - the spelling/tone axis, mirroring
// getEtymologyReview.ts's shape. Reuses diagnoseEntry directly (same
// function applySpellingDecision.ts's adopt_kaikki verification already
// relies on) rather than reimplementing candidate-matching/tone-comparison
// logic. If this word already has a spelling decision, that decision is
// passed in as diagnoseEntry's override so an already-decided word reports
// its own resolved status (e.g. 'verified_keep_ours'), not a fresh
// re-proposal as if nothing had been decided.

import {
  checkSyllableSplit,
  diagnoseEntry,
  orthographyInsensitiveForm,
  resolveEffectiveDisplayText,
  type CheckSyllableSplitResult,
  type DiagnoseEntryResult,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { loadAxisDecided, loadAxisOverride, loadDefinition, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

export interface SpellingReviewResult extends DiagnoseEntryResult, CheckSyllableSplitResult {
  syllables: string[];
  definition: string | null;
  axisDecided: AxisDecided;
}

export async function getSpellingReview(client: Queryable, wordId: string, userId: string): Promise<SpellingReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const definition = await loadDefinition(client, wordId);
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const override = await loadAxisOverride(client, wordId, 'spelling');

  const key = orthographyInsensitiveForm(entry.displayText);
  const senses = await loadKaikkiSensesForKey(client, key);
  const lexicon = senses.length > 0 ? { [key]: senses } : {};

  const diagnosis = diagnoseEntry(wordId, entry, lexicon, override);

  // Checks the syllable split against the spelling this word is BECOMING,
  // not necessarily the one on record - if adopt_kaikki has already been
  // decided, resolveEffectiveDisplayText substitutes the adopted spelling
  // (matches applySpellingDecision.ts's own inlined version of this same
  // rationale for the write side).
  const effective = resolveEffectiveDisplayText(entry, diagnosis, override);
  const syllableSplit = checkSyllableSplit(effective.displayText, entry.syllables, override, effective.wasSubstituted);

  return {
    ...diagnosis,
    ...syllableSplit,
    syllables: entry.syllables,
    definition,
    axisDecided,
  };
}

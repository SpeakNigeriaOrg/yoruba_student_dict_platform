// handlers/getEntryReview.ts
//
// Backs GET /words/{wordId}/entry - the entry axis: a word's written form
// AND its meaning, reviewed as one unit. Replaces the separate
// getSpellingReview.ts/getDefinitionReview.ts, because the spelling of a
// Yoruba word is not separable from its sense: tone marks and underdots ARE
// semantic, so confirming that a form is correct without knowing which
// gloss is being confirmed isn't a decision about anything.
//
// The two former handlers differed in exactly two ways, and BOTH are
// preserved here rather than averaged:
//
//   1. Lexicon scope. Spelling looked up only this word's own orthography
//      key; definition needed the full corpus, because an explicit
//      definitionSourceForm override can point at ANY Kaikki record (that
//      is the entire point of the manual search-and-redirect). The full
//      corpus is the superset, so it's what's loaded - same accepted
//      small-corpus tradeoff kaikkiSearch.ts already makes.
//
//   2. Whether the stored decision feeds diagnoseEntry. Spelling passed it
//      in, so an already-decided word reports its own resolved status
//      ('verified_keep_ours') instead of re-proposing from scratch.
//      Definition deliberately passed NO override, because the meaning link
//      is independent of which record the spelling axis compares against
//      (resolveDefinitionSource's "MEANING LINK" note). So diagnoseEntry
//      runs TWICE over the one loaded lexicon - cheap, both are pure
//      in-memory calls, and collapsing them to one would silently change
//      which Kaikki record definitions resolve against.

import {
  checkDefinition,
  checkSyllableSplit,
  diagnoseEntry,
  resolveDefinitionSource,
  resolveEffectiveDisplayText,
  type CheckDefinitionResult,
  type CheckSyllableSplitResult,
  type DiagnoseEntryResult,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';
import { loadAxisDecided, loadAxisOverride, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

export interface EntryReviewResult extends DiagnoseEntryResult, CheckSyllableSplitResult, CheckDefinitionResult {
  syllables: string[];
  axisDecided: AxisDecided;
}

export async function getEntryReview(client: Queryable, wordId: string, userId: string): Promise<EntryReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const override = await loadAxisOverride(client, wordId, 'entry');
  const lexicon = await loadFullKaikkiLexicon(client);

  // --- written form ---
  const diagnosis = diagnoseEntry(wordId, entry, lexicon, override);
  const effective = resolveEffectiveDisplayText(entry, diagnosis, override);
  const syllableSplit = checkSyllableSplit(effective.displayText, entry.syllables, override, effective.wasSubstituted);

  // --- meaning (see note 2 above: no override here, by design) ---
  const freshDiagnosis = diagnoseEntry(wordId, entry, lexicon);
  const source = resolveDefinitionSource(
    freshDiagnosis.matchedForm,
    freshDiagnosis.matchedGlosses,
    freshDiagnosis.matchedAltOfTargets,
    lexicon,
    override,
  );
  const definitionFields = checkDefinition(
    entry,
    freshDiagnosis.englishHint ?? '',
    source.glosses,
    override,
    source.sourceForm,
    source.isCrossReference,
    source.sourceForm === (freshDiagnosis.matchedForm ?? null),
    source.note,
  );

  return {
    ...diagnosis,
    ...syllableSplit,
    ...definitionFields,
    syllables: entry.syllables,
    axisDecided,
  };
}

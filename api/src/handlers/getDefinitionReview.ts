// handlers/getDefinitionReview.ts
//
// Backs GET /words/{wordId}/definition - the definition axis, mirroring
// getEtymologyReview.ts/getSpellingReview.ts's shape. Runs the same real
// pipeline definitionAxis.test.ts's parity tests verify against
// generate_diagnostics.py: diagnoseEntry -> resolveDefinitionSource ->
// checkDefinition. diagnoseEntry runs with no spelling override here -
// this axis's own proposal is independent of whatever the spelling axis
// eventually decides (see resolveDefinitionSource's own "MEANING LINK,
// independent of which record the spelling axis compares against").

import {
  checkDefinition,
  diagnoseEntry,
  resolveDefinitionSource,
  type CheckDefinitionResult,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';
import { loadAxisDecided, loadAxisOverride, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

export interface DefinitionReviewResult extends CheckDefinitionResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  axisDecided: AxisDecided;
}

export async function getDefinitionReview(client: Queryable, wordId: string, userId: string): Promise<DefinitionReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const override = await loadAxisOverride(client, wordId, 'definition');

  // The full corpus (not just this word's own orthography key) is loaded
  // here - unlike the narrower per-key lookups elsewhere, an explicit
  // definitionSourceForm override needs to resolve against ANY Kaikki
  // record, not just ones sharing this word's own spelling (that's the
  // whole point of a manual search-and-redirect override). Same accepted
  // small-corpus tradeoff as kaikkiSearch.ts.
  const lexicon = await loadFullKaikkiLexicon(client);

  const diagnosis = diagnoseEntry(wordId, entry, lexicon);
  const source = resolveDefinitionSource(diagnosis.matchedForm, diagnosis.matchedGlosses, diagnosis.matchedAltOfTargets, lexicon, override);
  const fields = checkDefinition(
    entry,
    diagnosis.englishHint ?? '',
    source.glosses,
    override,
    source.sourceForm,
    source.isCrossReference,
    source.sourceForm === (diagnosis.matchedForm ?? null),
    source.note,
  );

  return {
    wordId,
    displayText: entry.displayText,
    syllables: entry.syllables,
    axisDecided,
    ...fields,
  };
}

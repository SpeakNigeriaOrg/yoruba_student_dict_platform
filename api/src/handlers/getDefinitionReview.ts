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
  orthographyInsensitiveForm,
  resolveDefinitionSource,
  type CheckDefinitionResult,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { loadAxisDecided, loadAxisOverride, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

export interface DefinitionReviewResult extends CheckDefinitionResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  axisDecided: AxisDecided;
}

export async function getDefinitionReview(client: Queryable, wordId: string): Promise<DefinitionReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const axisDecided = await loadAxisDecided(client, wordId);
  const override = await loadAxisOverride(client, wordId, 'definition');

  const key = orthographyInsensitiveForm(entry.displayText);
  const senses = await loadKaikkiSensesForKey(client, key);
  const lexicon = senses.length > 0 ? { [key]: senses } : {};

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

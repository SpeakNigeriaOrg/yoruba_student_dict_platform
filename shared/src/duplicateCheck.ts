// duplicateCheck.ts
//
// Port of duplicate_check.py - checks whether a Kaikki search candidate
// (about to be added as a new vocab word via the Add Word screen) is a
// likely duplicate of an EXISTING vocab entry, either literally the same
// spelling or the same underlying Kaikki concept reached via a different
// spelling. Never blocks anything - flags for a human, never auto-decides.
//
// Reuses diagnoseEntry's own hint-disambiguated match for each existing
// word (the ONE sense that word actually resolves to), not a raw union of
// every homograph sense sharing its base spelling - comparing by base
// spelling alone would false-flag e.g. every one of Kaikki's ~8 unrelated
// "owo" senses (hand, money, business, a city name, ...) as a duplicate of
// every other one.

import { diagnoseEntry } from './diagnoseEntry.js';
import { orthographyInsensitiveForm } from './orthography.js';
import type { DiagnosticsOverrides, KaikkiLexicon, Vocab } from './types.js';

export interface DuplicateMatch {
  wordId: string;
  displayText: string;
  reason: string;
}

export function findPossibleDuplicates(
  candidateSpelling: string,
  candidateAltOfTargets: string[] | null | undefined,
  vocab: Vocab,
  lexicon: KaikkiLexicon,
  overrides: DiagnosticsOverrides,
): DuplicateMatch[] {
  const candidateConcepts = new Set<string>([candidateSpelling, ...(candidateAltOfTargets ?? [])]);
  const candidateBase = orthographyInsensitiveForm(candidateSpelling);

  const matches: DuplicateMatch[] = [];
  for (const [wordId, entry] of Object.entries(vocab)) {
    const displayText = entry.displayText;

    // Exact spelling match is always worth flagging, resolvable Kaikki
    // concept or not - two vocab entries with the identical displayText is
    // always worth a human's attention.
    if (displayText === candidateSpelling) {
      matches.push({ wordId, displayText, reason: 'identical spelling' });
      continue;
    }

    const result = diagnoseEntry(wordId, entry, lexicon, overrides[wordId]);
    const existingConcepts = new Set<string>();
    if (result.canonicalForm) existingConcepts.add(result.canonicalForm);
    for (const target of result.matchedAltOfTargets ?? []) existingConcepts.add(target);

    if (existingConcepts.size > 0) {
      // This word HAS a resolvable Kaikki concept - compare by concept
      // only. Base-spelling coincidence alone means nothing here.
      if ([...candidateConcepts].some((c) => existingConcepts.has(c))) {
        matches.push({ wordId, displayText, reason: 'same Kaikki entry, different spelling' });
      }
    } else if (orthographyInsensitiveForm(displayText) === candidateBase) {
      // No Kaikki concept to compare - base-spelling overlap is the best
      // fallback signal available.
      matches.push({
        wordId,
        displayText,
        reason: 'same base spelling (tone/underdot aside) - no confirmed Kaikki link to compare meaning',
      });
    }
  }

  return matches;
}

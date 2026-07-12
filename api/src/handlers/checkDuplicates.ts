// handlers/checkDuplicates.ts
//
// Backs GET /duplicate-check?spelling=...&altOfTargets=... - flags likely
// duplicates before adding a new word, wrapping shared/'s already-ported
// findPossibleDuplicates. Never blocks anything - a warning for a human,
// same "fail open" principle as the old tool's add_word.js.

import { findPossibleDuplicates, type DuplicateMatch } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';
import { loadAllSpellingOverrides, loadVocab } from '../reviewShared.js';

export async function checkDuplicatesHandler(
  client: Queryable,
  candidateSpelling: string,
  candidateAltOfTargets: string[],
): Promise<DuplicateMatch[]> {
  const vocab = await loadVocab(client);
  const lexicon = await loadFullKaikkiLexicon(client);
  const overrides = await loadAllSpellingOverrides(client);
  return findPossibleDuplicates(candidateSpelling, candidateAltOfTargets, vocab, lexicon, overrides);
}

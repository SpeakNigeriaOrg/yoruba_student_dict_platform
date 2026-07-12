// handlers/searchVocab.ts
//
// Backs GET /vocab-search?q=... - search over golden_record itself (not
// Kaikki), for manually adding an etymology component that wasn't
// auto-proposed, or picking phrase components when adding a new word.
// Reuses shared/'s already-ported searchVocab directly.

import { searchVocab, type VocabSearchResult } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadVocab } from '../reviewShared.js';

export async function searchVocabHandler(client: Queryable, query: string): Promise<VocabSearchResult[]> {
  const vocab = await loadVocab(client);
  return searchVocab(vocab, query);
}

// handlers/searchKaikki.ts
//
// Backs GET /kaikki-search?q=... - manual fallback search over the
// whole Kaikki corpus, for when the automatic candidate match (spelling
// axis) or gloss match (definition axis) is wrong, ambiguous, or missing.
// Reuses shared/'s already-ported searchKaikki/buildSearchIndex directly -
// no new matching logic, just wiring real Postgres data through it.

import { buildSearchIndex, searchKaikki, type KaikkiSearchResult } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';

export async function searchKaikkiHandler(client: Queryable, query: string): Promise<KaikkiSearchResult[]> {
  const lexicon = await loadFullKaikkiLexicon(client);
  const records = buildSearchIndex(lexicon);
  return searchKaikki(records, query);
}

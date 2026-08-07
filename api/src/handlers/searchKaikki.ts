// handlers/searchKaikki.ts
//
// Backs GET /kaikki-search?q=... - manual fallback search over the
// whole Kaikki corpus, for when the automatic candidate match (spelling
// axis) or gloss match (definition axis) is wrong, ambiguous, or missing.
// Reuses shared/'s already-ported searchKaikki/buildSearchIndex directly -
// no new matching logic, just wiring real Postgres data through it.
//
// ---------------------------------------------------------------------------
// The results say whether they are already in the dictionary
// ---------------------------------------------------------------------------
// They did not, and that was a real bug rather than a missing nicety. Adding a word IS choosing an
// etymology, and since 0014 `entry_id` identifies an etymology exactly - so "is this already in the
// dictionary?" has a precise answer. The search never asked it, so a curator was offered `jẹun` as a
// new word when `jeun_eat` already cited the very etymology on offer, and the only thing that spoke up
// was an after-the-fact SPELLING warning. Spelling cannot answer this question: `kọ́` is three
// etymologies sharing one spelling.
//
// The enrichment is deliberately here rather than inside shared's searchKaikki, which is a pure
// function over the lexicon and stays that way - a claim is production state, not corpus content.

import { buildSearchIndex, orthographyInsensitiveForm, searchKaikki, type KaikkiSearchResult } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadEntryClaims, loadIdentityUncomparableWords } from '../entryClaims.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';

export async function searchKaikkiHandler(client: Queryable, query: string): Promise<KaikkiSearchResult[]> {
  const lexicon = await loadFullKaikkiLexicon(client);
  const records = buildSearchIndex(lexicon);
  const results = searchKaikki(records, query);
  // No results means nothing to label - and the two lookups below would otherwise run for a query
  // that matched nothing at all.
  if (results.length === 0) return results;

  const entryIds = results.map((result) => result.entryId).filter((id): id is string => id !== null);
  const [claims, uncomparable] = await Promise.all([
    loadEntryClaims(client, entryIds),
    loadIdentityUncomparableWords(client),
  ]);

  return results.map((result) => {
    const claim = result.entryId ? claims.get(result.entryId) ?? null : null;
    // Spelling is offered ONLY where identity is silent. A free etymology whose spelling collides with
    // a word we cannot compare by id is the one case worth a human's attention; a taken etymology
    // already has its authoritative answer, and adding a spelling note under it would bury it.
    const spellingMatches = claim
      ? []
      : uncomparable.filter((word) =>
          result.standardForms.some((form) => orthographyInsensitiveForm(form) === word.base),
        ).map((word) => ({ wordId: word.wordId, displayText: word.displayText }));
    return { ...result, claim, spellingMatches };
  });
}

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
  const [claims, uncomparable, heldParts] = await Promise.all([
    loadEntryClaims(client, entryIds),
    loadIdentityUncomparableWords(client),
    loadHeldParts(client, results),
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
    return { ...result, claim, spellingMatches, partWords: partWords(result, heldParts) };
  });
}

interface HeldPart {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryId: string | null;
}

/** For each part Wiktionary names (componentCandidates, in order), the words we hold that it could
 * be - so Add Word can say which one to add, rather than leaving the curator to search for it.
 *
 * A word whose citation is one of the etymologies the part names is that part exactly
 * (`citesThisPart`); a word that merely shares the spelling may be a different word altogether -
 * the three kọ́ - and is offered as such. */
function partWords(result: KaikkiSearchResult, held: HeldPart[]): KaikkiSearchResult['partWords'] {
  return (result.componentCandidates ?? []).map((c) => {
    const ids = c.entryIds ?? [];
    const form = c.form.normalize('NFC');
    return held
      .filter((w) => (w.entryId !== null && ids.includes(w.entryId)) || w.displayText.normalize('NFC') === form)
      .map((w) => ({
        wordId: w.wordId,
        displayText: w.displayText,
        syllables: w.syllables,
        definition: w.definition,
        citesThisPart: w.entryId !== null && ids.includes(w.entryId),
      }))
      .sort((a, b) => Number(b.citesThisPart) - Number(a.citesThisPart));
  });
}

async function loadHeldParts(client: Queryable, results: KaikkiSearchResult[]): Promise<HeldPart[]> {
  const parts = results.flatMap((r) => r.componentCandidates ?? []);
  if (parts.length === 0) return [];
  const { rows } = await client.query<{ word_id: string; display_text: string; syllables: string[]; definition: string | null; entry_id: string | null }>(
    `select g.word_id, g.display_text, g.syllables, g.definition, c.entry_id
       from golden_record g
       left join upstream_citations c on c.word_id = g.word_id
      where c.entry_id = any($1) or normalize(g.display_text, NFC) = any($2)`,
    [[...new Set(parts.flatMap((p) => p.entryIds ?? []))], [...new Set(parts.map((p) => p.form.normalize('NFC')))]],
  );
  return rows.map((r) => ({ wordId: r.word_id, displayText: r.display_text, syllables: r.syllables ?? [], definition: r.definition, entryId: r.entry_id }));
}

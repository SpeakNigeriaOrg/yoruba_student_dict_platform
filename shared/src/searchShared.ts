// searchShared.ts
//
// Query-classification heuristics shared by kaikkiSearch.ts and
// vocabSearch.ts, ported from kaikki_search.py (vocab_search.py's Python
// original imports these two helpers directly from kaikki_search.py rather
// than duplicating them).

import { orthographyInsensitiveForm, TONE_MARKS, UNDERDOT_MARKS } from './orthography.js';

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'is', 'or', 'and', 'for']);

// ẹ/ọ/ṣ (and any combining tone/underdot mark) signal the query is meant
// as Yoruba spelling, not English - without this, a query like "kaṣu" gets
// tokenized on the non-ASCII ṣ into fragments that then spuriously match
// unrelated one-letter/pronoun glosses.
const YORUBA_ONLY_CHARS = new Set(['ẹ', 'ọ', 'ṣ', ...TONE_MARKS, ...UNDERDOT_MARKS]);

export function looksLikeYoruba(query: string): boolean {
  const decomposed = query.toLowerCase().normalize('NFD');
  return [...decomposed].some((c) => YORUBA_ONLY_CHARS.has(c));
}

/** English words in a gloss or a query, lowercased, stopwords dropped.
 *
 * ---------------------------------------------------------------------------
 * Marks are stripped BEFORE tokenising
 * ---------------------------------------------------------------------------
 * `[a-z0-9']+` on un-normalised text treats every non-ASCII character as a separator, so a Yoruba
 * word inside an English gloss is shredded rather than skipped:
 *
 *     'alternative form of ọmọ (“child”)'  ->  ['alternative', 'form', 'm', 'child']
 *
 * That stray `m` is not harmless - it is a token that then matches any query containing `m`, and it
 * exists in hundreds of cross-reference glosses. Stripping tone marks and underdots first turns
 * `ọmọ` into `omo`, which is a real word rather than a fragment. It reuses the same
 * `orthographyInsensitiveForm` the Yoruba side of the search has always used, so the two halves fold
 * marks identically rather than by two separate rules.
 *
 * A trailing possessive is dropped too. The apostrophe sits INSIDE the character class, so
 * "a child's toy" produced `child's`, which never equalled `child` - the gloss mentioned a child and
 * the search could not tell. */
export function tokenizeEnglish(text: string): string[] {
  const matches = orthographyInsensitiveForm(text).match(/[a-z0-9']+/g) ?? [];
  return matches
    .map((t) => t.replace(/'s$/, ''))
    .filter((t) => t !== '' && !STOPWORDS.has(t));
}

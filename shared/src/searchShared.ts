// searchShared.ts
//
// Query-classification heuristics shared by kaikkiSearch.ts and
// vocabSearch.ts, ported from kaikki_search.py (vocab_search.py's Python
// original imports these two helpers directly from kaikki_search.py rather
// than duplicating them).

import { TONE_MARKS, UNDERDOT_MARKS } from './orthography.js';

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

export function tokenizeEnglish(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return matches.filter((t) => !STOPWORDS.has(t));
}

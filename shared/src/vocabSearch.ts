// vocabSearch.ts
//
// Port of vocab_search.py - search over golden_record itself, not Kaikki.
// Backs the Add Phrase screen's component picker and the Etymology
// screen's manual-components widget. Reuses kaikkiSearch's Yoruba/English
// query-classification heuristics over a much smaller corpus, so no
// separate homograph-sense handling is needed (one vocab entry, one
// result, unlike Kaikki's per-sense records).

import { orthographyInsensitiveForm, toneInsensitiveForm } from './orthography.js';
import { looksLikeYoruba, tokenizeEnglish } from './searchShared.js';
import type { Vocab } from './types.js';

export type VocabSearchTier = 'yoruba_exact' | 'yoruba_tone' | 'yoruba_ortho' | 'yoruba_prefix' | 'yoruba_substring' | 'word_id' | 'english';

const TIER_RANK: Record<VocabSearchTier, number> = {
  yoruba_exact: 0,
  yoruba_tone: 1,
  yoruba_ortho: 2,
  yoruba_prefix: 3,
  yoruba_substring: 4,
  word_id: 5,
  english: 6,
};

export interface VocabSearchResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  baseSpelling: string;
  matchedVia: VocabSearchTier;
  /** 'phrase' when this result is itself a composed phrase; absent for an ordinary word.
   *
   * Carried because the component picker is the main consumer, and without it a phrase was offered as
   * a candidate component of a phrase with nothing to say it was one - so `ẹ jọ̀ọ́ — Please  [Add]`
   * looked like an invitation to create a duplicate of a word that already existed. `VocabEntry`
   * already knew (loadVocab sets it from golden_record.entry_type); the projection simply dropped it. */
  entryType?: 'phrase';
}

export function searchVocab(vocab: Vocab, query: string, limit = 15): VocabSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const qExact = trimmed.toLowerCase();
  const qTone = toneInsensitiveForm(trimmed);
  const qOrtho = orthographyInsensitiveForm(trimmed);
  const qTokens = looksLikeYoruba(trimmed) ? [] : tokenizeEnglish(trimmed);

  const results = new Map<string, { tier: VocabSearchTier; score: number }>();

  for (const [wordId, entry] of Object.entries(vocab)) {
    const displayText = entry.displayText;
    const fExact = displayText.toLowerCase();
    const fTone = toneInsensitiveForm(displayText);
    const fOrtho = orthographyInsensitiveForm(displayText);

    let tier: VocabSearchTier | null = null;
    if (fExact === qExact) tier = 'yoruba_exact';
    else if (qTone && fTone === qTone) tier = 'yoruba_tone';
    else if (qOrtho && fOrtho === qOrtho) tier = 'yoruba_ortho';
    else if (qOrtho && qOrtho.length >= 2 && fOrtho.startsWith(qOrtho)) tier = 'yoruba_prefix';
    // A fragment from anywhere in the spelling, ranked below every form of prefix match.
    //
    // The one deliberate divergence from vocab_search.py, added when the browse screen stopped
    // filtering with a private `includes` of its own and started asking this function instead. A
    // browse box narrows a list the reader is looking at, so `sílẹ̀` has to find `fi sílẹ̀` - the
    // fragment is a whole word of the phrase, just not the first one. Without this tier the only
    // thing that answered such a query was the word_id tier, which works by accident (ids embed
    // the spelling) and stops working the moment an id is named for its meaning instead.
    //
    // Free with respect to the parity corpus: none of the recorded fixture queries gains a result
    // from it, so the ported behaviour is unchanged everywhere it was ever measured. Ranked after
    // the prefix tier so it can only ADD results below the ones Python already ordered, never
    // reorder them.
    else if (qOrtho && qOrtho.length >= 2 && fOrtho.includes(qOrtho)) tier = 'yoruba_substring';
    else if (qExact && wordId.toLowerCase().includes(qExact)) tier = 'word_id';

    if (tier) results.set(wordId, { tier, score: 0 });
  }

  if (qTokens.length > 0) {
    for (const [wordId, entry] of Object.entries(vocab)) {
      if (results.has(wordId)) continue;
      const defTokens = tokenizeEnglish(entry.definition ?? '');
      const score = qTokens.reduce((sum, t) => sum + defTokens.filter((d) => d === t).length, 0);
      if (score > 0) results.set(wordId, { tier: 'english', score });
    }
  }

  const ranked = [...results.entries()].sort(
    ([, a], [, b]) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score,
  );

  return ranked.slice(0, limit).map(([wordId, { tier }]) => {
    const entry = vocab[wordId];
    return {
      wordId,
      displayText: entry.displayText,
      syllables: entry.syllables,
      definition: entry.definition ?? null,
      baseSpelling: orthographyInsensitiveForm(entry.displayText),
      matchedVia: tier,
      ...(entry.type === 'phrase' ? { entryType: 'phrase' as const } : {}),
    };
  });
}

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

export type VocabSearchTier = 'yoruba_exact' | 'yoruba_tone' | 'yoruba_ortho' | 'yoruba_prefix' | 'word_id' | 'english';

const TIER_RANK: Record<VocabSearchTier, number> = {
  yoruba_exact: 0,
  yoruba_tone: 1,
  yoruba_ortho: 2,
  yoruba_prefix: 3,
  word_id: 4,
  english: 5,
};

export interface VocabSearchResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  baseSpelling: string;
  matchedVia: VocabSearchTier;
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
    };
  });
}

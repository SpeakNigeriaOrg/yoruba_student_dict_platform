// kaikkiSearch.ts
//
// Port of kaikki_search.py - flexible local search over the Kaikki
// lexicon, letting a human chase down any kind of near-miss (a different
// consonant, an alternate transliteration, an English gloss) rather than
// being limited to diagnoseEntry's one hardcoded relaxation
// (collapseRepeatedVowels). Conceptually ports yorubadict's search
// approach (three Yoruba orthography tiers plus an English keyword search
// over glosses), not a literal port of any indexing machinery - this
// project's corpus is small enough that a linear scan suffices.

import { orthographyInsensitiveForm, toneInsensitiveForm } from './orthography.js';
import { looksLikeYoruba, tokenizeEnglish } from './searchShared.js';
import type { KaikkiLexicon, KaikkiSense } from './types.js';

export interface KaikkiSearchRecord {
  form: string;
  sense: KaikkiSense;
}

/** Flattens the lexicon (keyed by orthography-insensitive base spelling ->
 * list of senses) into (surface_form, sense) pairs - every standardForm,
 * not just the canonical one, since a search should find a word under any
 * spelling Kaikki records for it. */
export function buildSearchIndex(lexicon: KaikkiLexicon): KaikkiSearchRecord[] {
  const records: KaikkiSearchRecord[] = [];
  for (const senses of Object.values(lexicon)) {
    for (const sense of senses) {
      const forms = sense.standardForms && sense.standardForms.length > 0 ? sense.standardForms : [sense.canonicalForm.value];
      for (const form of forms) {
        records.push({ form, sense });
      }
    }
  }
  return records;
}

type KaikkiSearchTier = 'yoruba_exact' | 'yoruba_tone' | 'yoruba_ortho' | 'yoruba_prefix' | 'english';

const TIER_RANK: Record<KaikkiSearchTier, number> = {
  yoruba_exact: 0,
  yoruba_tone: 1,
  yoruba_ortho: 2,
  yoruba_prefix: 3,
  english: 4,
};

export interface KaikkiSearchResult {
  form: string;
  pos: string;
  glosses: string[];
  matchedVia: KaikkiSearchTier;
  altOfTargets: string[];
  standardForms: string[];
}

// Keyed by sense CONTENT, not object identity: the lexicon deliberately
// cross-indexes the same underlying record under every spelling it's
// known by, which means the identical sense can appear under multiple
// lexicon keys - and after a JSON round-trip those become
// separate-but-equal objects. A content key collapses those back into one
// result while still keeping genuinely different homograph senses that
// merely share a spelling (different pos/glosses) separate.
function contentKey(sense: KaikkiSense): string {
  return JSON.stringify([sense.canonicalForm.value, sense.pos, sense.glosses]);
}

/** Searches Yoruba spellings (tiered exact/tone/underdot-insensitive/
 * prefix) and English glosses (keyword overlap) at once, merging results
 * with Yoruba tiers ranked above English matches. Every result is keyed by
 * sense identity (not by spelling), so two different senses that happen to
 * share a spelling (homographs) both show up rather than collapsing into
 * one. */
export function searchKaikki(records: KaikkiSearchRecord[], query: string, limit = 15): KaikkiSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const qExact = trimmed.toLowerCase();
  const qTone = toneInsensitiveForm(trimmed);
  const qOrtho = orthographyInsensitiveForm(trimmed);
  // Diacritic-bearing queries are clearly an attempt at Yoruba spelling,
  // not English - tokenizing them as English would fragment on the
  // non-ASCII characters and spuriously match unrelated short glosses.
  const qTokens = looksLikeYoruba(trimmed) ? [] : tokenizeEnglish(trimmed);

  const results = new Map<string, { tier: KaikkiSearchTier; score: number; sense: KaikkiSense }>();

  for (const { form, sense } of records) {
    const fExact = form.toLowerCase();
    const fTone = toneInsensitiveForm(form);
    const fOrtho = orthographyInsensitiveForm(form);

    let tier: KaikkiSearchTier | null = null;
    if (fExact === qExact) tier = 'yoruba_exact';
    else if (qTone && fTone === qTone) tier = 'yoruba_tone';
    else if (qOrtho && fOrtho === qOrtho) tier = 'yoruba_ortho';
    else if (qOrtho && qOrtho.length >= 2 && fOrtho.startsWith(qOrtho)) tier = 'yoruba_prefix';

    if (tier) {
      const key = contentKey(sense);
      const existing = results.get(key);
      if (!existing || TIER_RANK[tier] < TIER_RANK[existing.tier]) {
        results.set(key, { tier, score: 0, sense });
      }
    }
  }

  if (qTokens.length > 0) {
    for (const { sense } of records) {
      const key = contentKey(sense);
      if (results.has(key)) continue; // already found via a Yoruba tier - don't downgrade to English
      const glossTokens = tokenizeEnglish(sense.glosses.join(' '));
      const score = qTokens.reduce((sum, t) => sum + glossTokens.filter((g) => g === t).length, 0);
      if (score > 0) {
        results.set(key, { tier: 'english', score, sense });
      }
    }
  }

  const ranked = [...results.values()].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score);

  return ranked.slice(0, limit).map(({ tier, sense }) => ({
    form: sense.canonicalForm.value,
    pos: sense.pos,
    glosses: sense.glosses,
    matchedVia: tier,
    // Lets a human picking this as a meaning-link source see it's itself a
    // cross-reference before picking it - rather than unknowingly landing
    // on another dead end (resolveDefinitionSource only auto-follows one
    // hop; a human isn't limited to that).
    altOfTargets: sense.altOfTargets ?? [],
    // Every standard-tagged spelling variant Kaikki records for this sense
    // (canonical first) - lets a human adding a new vocab word pick a
    // specific alternate spelling instead of always defaulting to
    // canonical.
    standardForms: sense.standardForms && sense.standardForms.length > 0 ? sense.standardForms : [sense.canonicalForm.value],
  }));
}

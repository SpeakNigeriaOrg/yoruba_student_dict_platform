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
import {
  buildGlossStats,
  prefixMatchScore,
  scoreGlossesAgainstQuery,
  rootBonus,
  type GlossStats,
} from './englishRelevance.js';
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

// ---------------------------------------------------------------------------
// Three HARD tiers, then two that compete on score
// ---------------------------------------------------------------------------
// The first three are whole-string identifications at successively more forgiving normalisations:
// if you typed the word, you get the word, and nothing outranks that. They stay absolute.
//
// A PREFIX match is a different claim - "this word starts with what you typed" - and it used to
// outrank every English match automatically, however little of the word the query covered. Searching
// "eye" filled all fifteen results with Yoruba (it is ẹyẹ orthography-insensitively, and a prefix of
// eyeye/èyé/yéye), so `ojú` - whose gloss is literally "eye" - sat at #18 with no English result on
// the first page at all.
//
// So prefix and english share a rank and sort against each other by score. Measured on the real
// corpus: moon -> òṣùpá #3 to #1, eye -> ojú #18 to #9, dog -> ajá #3 to #2, and every Yoruba query
// tested (ọmọ, adiye, ile, oju, owo) unchanged. Going further - softening tone/ortho too - does get
// ojú to #1, but pushes the Yoruba query `owo` from #5 to #11, trading a Yoruba answer for an
// English one in a Yoruba dictionary. Not done.
const SOFT_RANK = 3;

const TIER_RANK: Record<KaikkiSearchTier, number> = {
  yoruba_exact: 0,
  yoruba_tone: 1,
  yoruba_ortho: 2,
  yoruba_prefix: SOFT_RANK,
  english: SOFT_RANK,
};

// PREFIX_SCALE and prefixMatchScore live in englishRelevance.ts, mirrored by yorubadict's
// english-relevance.js, so the two engines cannot drift on how a partial spelling compares to a
// gloss match.

export type EntryClaimStatus = 'in_dictionary' | 'requested';

/** Who already holds this etymology as their identity.
 *
 * Under the "an entry IS a Wiktionary etymology" model (0014), entry_id answers "is this already in
 * the dictionary?" exactly - the corpus has one entry_id per etymology, so equality is identity, not
 * a resemblance. That is worth stating because the curator flow used to answer the question by
 * comparing SPELLINGS, which cannot work: `kọ́` is three etymologies sharing one spelling, and `jẹun`
 * was already in the dictionary under the very etymology being offered again. */
export interface EntryClaim {
  status: EntryClaimStatus;
  /** The word that IS this etymology - existing for 'in_dictionary', planned for 'requested'. */
  wordId: string;
  displayText: string;
  /** 'requested' only, so the UI can point at the pending request. */
  contributionId?: string;
}

export interface KaikkiSearchResult {
  form: string;
  pos: string;
  glosses: string[];
  matchedVia: KaikkiSearchTier;
  altOfTargets: string[];
  standardForms: string[];
  /** The etymology this result IS. Picking a search result is how a word
   * enters the dictionary, so this is the moment the citation is free to
   * capture - the human has just told us which etymology they mean. Null
   * only for a corpus/fixture predating 0014. */
  entryId: string | null;
  /** Rendered alongside the glosses so the person picking can see WHICH
   * etymology they are choosing. `kọ́` returns three results differing only
   * by this and their glosses. */
  etymologyNumber: string | null;
  /** Whether this etymology is already someone's identity.
   *
   * Populated ONLY by the API handler (api/src/handlers/searchKaikki.ts), because it is production
   * state rather than corpus content - searchKaikki below is a pure function over the lexicon and
   * must stay that way. Three-valued on purpose:
   *
   *   undefined - nobody looked (a caller that never enriches, or a pure search)
   *   null      - looked, and this etymology is free
   *   EntryClaim- looked, and it is taken
   *
   * Collapsing undefined into null would make "we did not check" indistinguishable from "we checked
   * and it is available", and the UI must not print a reassurance it has not earned. */
  claim?: EntryClaim | null;
  /** SECONDARY, and deliberately narrow: dictionary words that share this result's spelling AND whose
   * identity entry_id cannot speak for - a word with no citation row at all (5 pre-0014 words) or an
   * exempt one (entry_id null, a real word with no Wiktionary entry).
   *
   * Those are the only cases where spelling is the best signal available, which is the entire reason
   * spelling matching survives at all now that identity is exact. Never populated for a CITED word:
   * a cited word sharing a spelling with a different etymology is the `kọ́` false positive, and
   * suppressing it is the point rather than an omission. */
  spellingMatches?: Array<{ wordId: string; displayText: string }>;
}

// One key per ETYMOLOGY. The lexicon deliberately cross-indexes the same
// underlying record under every spelling it's known by, so the identical
// etymology can appear under multiple lexicon keys - and after a JSON
// round-trip those become separate-but-equal objects. Keying collapses those
// back into one result while keeping genuinely different etymologies that
// merely share a spelling (the three `kọ́`s) separate.
//
// entryId is the right key and the content fallback is strictly worse: two
// distinct etymologies that happen to agree on form, pos AND glosses collapse
// into one under the content key, silently hiding one of them from the person
// choosing. The fallback exists only for a corpus/fixture predating 0014.
function senseKey(sense: KaikkiSense): string {
  if (sense.entryId) return `id:${sense.entryId}`;
  return `content:${JSON.stringify([sense.canonicalForm.value, sense.pos, sense.glosses])}`;
}

/** Each sense once, however many spellings it is indexed under.
 *
 * The English pass used to walk `records`, which holds one entry PER SPELLING - so a sense with
 * four standardForms was scored four times and written into the results map four times over. That
 * was harmless when the score was a pure function of the sense, and it is not harmless now that
 * the root bonus counts members of the match set. */
function dedupedSenses(records: KaikkiSearchRecord[]): Array<{ sense: KaikkiSense }> {
  const seen = new Set<string>();
  const out: Array<{ sense: KaikkiSense }> = [];
  for (const { sense } of records) {
    const key = senseKey(sense);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sense });
  }
  return out;
}

/** Corpus-wide gloss statistics for IDF, over each sense once. */
function glossStatsFor(records: KaikkiSearchRecord[]): GlossStats {
  return buildGlossStats(dedupedSenses(records).map(({ sense }) => sense.glosses));
}

/** Total gloss length in characters - the tie-break. */
function glossLength(sense: KaikkiSense): number {
  return sense.glosses.reduce((n, g) => n + g.length, 0);
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
      // A prefix match carries a real score now: how much of the word the query covers. The other
      // three are whole-string identifications, where "how much" is not a question.
      const score = tier === 'yoruba_prefix' ? prefixMatchScore(qOrtho.length, fOrtho.length) : 0;
      const key = senseKey(sense);
      const existing = results.get(key);
      // Better rank wins; at equal rank the better score does. The same sense reaches this loop
      // once per spelling it is indexed under, so a word can be a weak prefix match under one
      // spelling and a strong one under another.
      const better =
        !existing ||
        TIER_RANK[tier] < TIER_RANK[existing.tier] ||
        (TIER_RANK[tier] === TIER_RANK[existing.tier] && score > existing.score);
      if (better) results.set(key, { tier, score, sense });
    }
  }

  if (qTokens.length > 0) {
    // Per gloss, best-of, BM25-weighted, with a bonus for a gloss that IS the query. The old
    // one-liner counted occurrences across `glosses.join(' ')`, which rewarded verbosity: see
    // englishRelevance.ts for the measurements and why this is shared with yorubadict.
    const stats = glossStatsFor(records);
    const englishMatches: Array<{ key: string; sense: KaikkiSense; score: number }> = [];

    for (const { sense } of dedupedSenses(records)) {
      const key = senseKey(sense);
      const existing = results.get(key);
      // A HARD Yoruba tier is never downgraded - you typed the word, you get the word. A soft one
      // (prefix) is only a claim about spelling overlap, so if this sense ALSO means what was asked,
      // it keeps whichever of the two reads stronger.
      if (existing && TIER_RANK[existing.tier] < SOFT_RANK) continue;
      const score = scoreGlossesAgainstQuery(sense.glosses, qTokens, qOrtho, stats);
      if (score > 0 && (!existing || score > existing.score)) englishMatches.push({ key, sense, score });
    }

    // The root bonus is computed against the MATCH SET, so a productive root is only lifted when
    // the query also matched words built from it. That is what keeps it minor - see rootBonus.
    const matchShapes = englishMatches.map(({ sense }) => ({
      form: sense.canonicalForm.value,
      partForms: new Set((sense.componentCandidates ?? []).map((c) => orthographyInsensitiveForm(c.form))),
    }));
    for (const [i, match] of englishMatches.entries()) {
      const bonus = rootBonus(match.sense.canonicalForm.value, matchShapes.filter((_, j) => j !== i));
      results.set(match.key, { tier: 'english', score: match.score + bonus, sense: match.sense });
    }
  }

  const ranked = [...results.values()].sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      b.score - a.score ||
      // A real third key, but ONLY within the English tier.
      //
      // Equal scores used to fall back to Map insertion order, i.e. position in the corpus file -
      // which is the entire reason `Àjàyí` outranked `ọmọ` for "child". A terser gloss is the
      // likelier headline sense, and this is query-independent so it cannot smuggle file order
      // back in.
      //
      // Scoped to the SOFT tiers, which are the only ones that carry a score. The three hard tiers
      // all score 0, so an unscoped tie-break would reorder those too - a much wider change than
      // the bug needs, and one that moved Python-parity fixtures with nothing to do with relevance.
      (TIER_RANK[a.tier] >= SOFT_RANK && TIER_RANK[b.tier] >= SOFT_RANK
        ? glossLength(a.sense) - glossLength(b.sense)
        : 0),
  );

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
    // The whole point of the search, under the "an entry IS a Wiktionary
    // etymology" model: the caller persists this as the citation instead of
    // re-deriving it from the spelling later, which cannot be done (a
    // spelling maps to several etymologies).
    entryId: sense.entryId ?? null,
    etymologyNumber: sense.etymologyNumber ?? null,
  }));
}

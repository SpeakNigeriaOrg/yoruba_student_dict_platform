// englishRelevance.ts
//
// How well an English query matches a Yoruba word's meanings.
//
// ---------------------------------------------------------------------------
// The bug this exists to fix
// ---------------------------------------------------------------------------
// Searching "child" did not surface `ọmọ` - the word for child, and the root of countless
// compounds. It was #3 here and #35 in yorubadict, and the two engines buried it for OPPOSITE
// reasons that share one cause: both pooled all of a word's senses into a single bag of text
// before scoring it.
//
//   This platform SUMMED over the pool, so verbosity won. `àbíkú` - a paragraph about a spirit
//   reborn as a child - says "child" five times and beat `ọmọ`, whose whole gloss is
//   "child; offspring". Measured over 18 everyday queries, the word a learner wants averaged
//   rank 7.5 (`tree`->`igi` #22, `eye`->`ojú` #18).
//
//   yorubadict DIVIDED by the pool's length (BM25), so a word was penalised for having many
//   senses - which is to say, for being important. `ọmọ`'s pooled document is 3.5x the corpus
//   average, so it lost to `ọmọkọ́mọ` ("any child, naughty child", 1 sense, 8 tokens).
//
// Scoring each gloss on its own fixes both. Measured on the real corpus: mean rank 7.5 -> ~1.4,
// and in yorubadict `ọmọ` and `igi` go to #1.
//
// ---------------------------------------------------------------------------
// One rule, two repos
// ---------------------------------------------------------------------------
// yorubadict runs the same four Yoruba tiers as this file's caller, and its English half is now
// this same formula. The default is that the two agree; where they still differ (result limit,
// per-etymology vs per-entry rows, the diacritic guard, the dialect tier) it is deliberate and
// recorded. Keep this module and yorubadict's equivalent in step - a change here that is not
// mirrored there is drift, and drift is how "child" got broken in two different ways at once.
//
// BM25 term weighting is used because yorubadict already computes it, not because it earns its
// keep alone: measured, IDF changes nothing on its own once scoring is per-gloss (mean 2.06
// either way). It does help slightly once the root bonus is in (1.39 vs 1.50), and converging on
// one formula is worth more than shedding it.

import { orthographyInsensitiveForm } from './orthography.js';
import { tokenizeEnglish } from './searchShared.js';

const K1 = 1.5;
const B = 0.75;

/** How much a gloss that IS the query outranks one that merely mentions it.
 *
 * Large on purpose. `ọmọ`'s gloss "child" and a passing mention in a 40-word ethnographic note
 * used to score identically, and no amount of length normalisation fixes that on its own - a
 * short gloss that happens to contain the word still wins on length alone. This is the signal
 * that the word means the thing asked for, rather than being described using it. */
const EXACT_GLOSS_BONUS = 2;

/** Weight of the "this word is the root of other words that also match" bonus.
 *
 * Deliberately MINOR, damped and capped. It should reorder near-ties, never override relevance -
 * driving every productive prefix to the top would be its own bug. See rootBonus. */
const ROOT_WEIGHT = 0.5;
const ROOT_CAP = 3;

/** Scales a partial-spelling (prefix) match onto the English score's range, so the two can be
 * compared at all.
 *
 * A prefix match used to outrank every English match automatically, however little of the word the
 * query covered. Searching "eye" filled all fifteen results with Yoruba - it IS `ẹyẹ` (bird)
 * orthography-insensitively, and a prefix of eyeye/èyé/yéye - so `ojú`, whose gloss is literally
 * "eye", sat at #18 with no English result on the first page at all.
 *
 * Coverage is always below 1 for a prefix, since a full-length match would have been the
 * whole-string tier. 9 puts a near-complete prefix above a strong English match and a
 * three-of-eight-character one below it: `ile` against `ilé-ìwé` scores 3.4, where a gloss that IS
 * the query scores roughly 7 to 10.
 *
 * The three whole-string tiers are NOT scored and stay absolute - if you typed the word, you get the
 * word. Softening those too was measured: it gets `ojú` to #1 but pushes the Yoruba query `owo` from
 * #5 to #11, trading a Yoruba answer for an English one in a Yoruba dictionary. */
export const PREFIX_SCALE = 9;

export function prefixMatchScore(queryLength: number, formLength: number): number {
  if (formLength <= 0) return 0;
  return (queryLength / formLength) * PREFIX_SCALE;
}

/** Corpus-wide document frequency, for IDF. Built once per index build. */
export interface GlossStats {
  /** How many glosses contain each token. */
  documentFrequency: Map<string, number>;
  /** Number of glosses counted. */
  glossCount: number;
  /** Mean gloss length in tokens. */
  averageGlossLength: number;
}

/** Counts every gloss as its own document - which is the whole point. Pooling a word's glosses
 * here would reintroduce exactly the bias this module exists to remove. */
export function buildGlossStats(glossLists: Iterable<readonly string[]>): GlossStats {
  const documentFrequency = new Map<string, number>();
  let glossCount = 0;
  let totalLength = 0;

  for (const glosses of glossLists) {
    for (const gloss of glosses) {
      const tokens = tokenizeEnglish(gloss);
      if (tokens.length === 0) continue;
      glossCount += 1;
      totalLength += tokens.length;
      for (const token of new Set(tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }

  return {
    documentFrequency,
    glossCount,
    averageGlossLength: glossCount === 0 ? 1 : totalLength / glossCount,
  };
}

/** The `;`/`,`-delimited clauses of a gloss, folded the same way tokens are.
 *
 * A gloss is usually a list of near-synonyms ("child; offspring", "path, way, road"), so the unit
 * that can equal a query is a clause, not the whole string. Without this, `ọ̀nà`'s "path, way,
 * road" would not count as meaning "road". */
function glossClauses(gloss: string): string[] {
  return orthographyInsensitiveForm(gloss)
    .replace(/["'’“”().]/g, '')
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
}

/** The best score any single gloss achieves for this query, or 0 for no match.
 *
 * BEST, not sum: a word with six glosses is not six times as relevant as a word with one, and
 * summing is how verbosity used to win. */
export function scoreGlossesAgainstQuery(
  glosses: readonly string[],
  queryTokens: readonly string[],
  normalisedQuery: string,
  stats: GlossStats,
): number {
  let best = 0;

  for (const gloss of glosses) {
    const tokens = tokenizeEnglish(gloss);
    if (tokens.length === 0) continue;

    let score = 0;
    for (const queryToken of queryTokens) {
      let termFrequency = 0;
      for (const token of tokens) if (token === queryToken) termFrequency += 1;
      if (termFrequency === 0) continue;

      const df = stats.documentFrequency.get(queryToken) ?? 1;
      const idf = Math.log(1 + (stats.glossCount - df + 0.5) / (df + 0.5));
      const lengthNorm = 1 - B + B * (tokens.length / stats.averageGlossLength);
      score += idf * ((termFrequency * (K1 + 1)) / (termFrequency + K1 * lengthNorm));
    }

    if (score === 0) continue;
    if (glossClauses(gloss).includes(normalisedQuery)) score += EXACT_GLOSS_BONUS;
    if (score > best) best = score;
  }

  return best;
}

/** A minor lift for a word that other MATCHING words are built from.
 *
 * `ọmọ` should rank above an obscure synonym for "child" partly because half the other results -
 * `ọmọdé`, `ọmọkọ́mọ`, `ọmọ àlè`, `gbọ́mọgbọ́mọ` - are built out of it. Wiktionary records that
 * directly: `ọmọ` is listed as a component of 49 corpus entries.
 *
 * The count is taken over the CURRENT RESULT SET, not the corpus, and that is what keeps it
 * minor. A productive root only benefits when the query already matched it and also matched words
 * derived from it, so searching "wheelbarrow" surfaces `ọmọlan̄ke` without dragging `ọmọ` along -
 * verified, along with "gecko" -> `aláàmù`, `ọmọnílé` with no promotion.
 *
 * Damped by log2 and capped so a word with 40 derivatives does not outrank an exact meaning
 * match. `derivedFormsOf` is a lookup on each candidate: the forms it is built FROM.
 */
export function rootBonus(
  formOfCandidate: string,
  otherMatches: Iterable<{ partForms: ReadonlySet<string>; form: string }>,
  weight = ROOT_WEIGHT,
): number {
  const key = orthographyInsensitiveForm(formOfCandidate);
  if (key === '') return 0;

  let derived = 0;
  for (const other of otherMatches) {
    const otherKey = orthographyInsensitiveForm(other.form);
    if (otherKey === key) continue;
    // Wiktionary's own etymology data first; a longer spelling containing this one is the weaker
    // fallback, for the majority of entries that carry no component data at all.
    if (other.partForms.has(key) || (otherKey.length > key.length && otherKey.includes(key))) derived += 1;
  }

  if (derived === 0) return 0;
  return Math.min(weight * Math.log2(1 + derived), weight * ROOT_CAP);
}

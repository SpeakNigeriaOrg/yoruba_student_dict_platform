// tone.ts
//
// Reading and writing the tone of one syllable.
//
// This exists because tone is the thing a Yoruba dictionary most often gets wrong,
// and typing it is the hardest part of correcting it. Base letters are usually
// right; the marks over them are not. So the review task asks about tone directly -
// three choices per syllable - and generates the diacritics, which means a
// contributor never types a combining mark and cannot produce a malformed one.
//
// ---------------------------------------------------------------------------
// Mid tone depends on what carries it. This is a rule, not a preference.
// ---------------------------------------------------------------------------
// Measured over the whole ingested corpus (5,580 distinct forms, 14,666 syllables):
//
//   on a VOWEL           mid is UNMARKED        4,289 unmarked vs 4 macron, and
//                                               those 4 are Wiktionary's own
//                                               letter-description entries ("the
//                                               letter <ẹ> with mid tone (not
//                                               usually marked overtly)"), not words
//   on a SYLLABIC NASAL  mid is USUALLY a
//                        MACRON, but not
//                        always               26 macron vs 6 unmarked
//
// The macron is not decorative: it is what distinguishes a SYLLABIC nasal from a CODA
// one. syllabifyWord's vowel branch absorbs an untoned `n` before a consonant as a coda,
// so `gbangba` is two syllables [gban][gba] while `gban̄gba` is three, [gba][n̄][gba].
// Dropping it does not just lose the tone, it re-analyses the word.
//
// But the convention is not universal, which is why that last row matters in BOTH
// directions. A bare `n` is ordinary mid tone written by someone who does not use
// macrons, not missing information. Reading it as "unknown" would interrogate a reviewer
// about a word nobody got wrong; writing a macron onto it would edit a spelling nobody
// asked to change. toneOf and applyTone each handle one half of that.
//
// ---------------------------------------------------------------------------
// One tone slot per syllable
// ---------------------------------------------------------------------------
// Also measured: 0 of those 14,666 syllables carry more than one tone mark. That is
// what makes a three-button-per-syllable editor a complete representation of a
// word's tone rather than an approximation.

import { TONE_MARKS } from './orthography.js';

// Written with fromCharCode for the reason textFingerprint.ts documents: a literal
// combining mark is invisible in source and has been silently eaten by tooling in
// this repo before, and an escape form was itself rewritten into literal bytes.
const GRAVE = String.fromCharCode(0x0300); // low
const ACUTE = String.fromCharCode(0x0301); // high
const MACRON = String.fromCharCode(0x0304); // explicit mid on a syllabic nasal
const CIRCUMFLEX = String.fromCharCode(0x0302); // not a Yoruba tone; see toneOf

/** Base vowels as they appear AFTER NFD, so the underdot of ẹ/ọ has already been
 * split off and does not need listing. ɛ/ɔ have no decomposition and are included
 * because Wiktionary's Yoruba entries use them in phonetic spellings. */
const BASE_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'ɛ', 'ɔ']);
const BASE_NASALS = new Set(['m', 'n']);

export type Tone = 'low' | 'mid' | 'high';

/** What in this syllable carries the tone.
 *
 * A vowel wins over a nasal, because a syllable like `gban` has both and the tone
 * belongs on the vowel - the `n` there is a coda, not the syllable's nucleus. Null
 * means nothing can carry tone: Wiktionary has bare letter-name entries (`b`, `gb`,
 * `h`) that syllabify to consonants only. */
export type ToneBearer = 'vowel' | 'nasal' | null;

export function toneBearerKind(syllable: string): ToneBearer {
  const chars = [...syllable.normalize('NFD')];
  if (chars.some((c) => BASE_VOWELS.has(c.toLowerCase()))) return 'vowel';
  if (chars.some((c) => BASE_NASALS.has(c.toLowerCase()))) return 'nasal';
  return null;
}

/** The tone this syllable is written with.
 *
 * An unmarked bearer is MID, whether it is a vowel or a syllabic nasal. On a vowel that
 * is simply the standard orthography. On a nasal the explicit form is a macron, but the
 * convention is not universal - a bare `n` is mid written by someone who does not use
 * macrons, so treating it as unknown would make the editor demand an answer to a question
 * the source already answered.
 *
 * Null means only "there is no tone here to read", in three cases:
 *
 *   no bearer at all    a bare consonant - Wiktionary has letter-name entries (`gb`)
 *   circumflex          `ộ` in the lexicon. Not one of Yoruba's three tones
 *   macron on a VOWEL   `ọ̄`, `ẹ̄` - Wiktionary's letter-description entries ("the
 *                       letter <ẹ> with mid tone (not usually marked overtly)"). Mid on
 *                       a vowel is unmarked, so calling these mid would let applyTone
 *                       strip the macron they exist to show.
 *
 * The last two are what keep applyTone(s, toneOf(s)) an exact identity: a syllable this
 * editor cannot represent is left alone rather than rewritten. */
export function toneOf(syllable: string): Tone | null {
  const bearer = toneBearerKind(syllable);
  if (bearer === null) return null;

  const chars = [...syllable.normalize('NFD')];

  // The two out-of-model marks, documented above. Left alone rather than reported as a
  // tone, which is what keeps applyTone(s, toneOf(s)) an exact identity.
  if (chars.includes(CIRCUMFLEX)) return null;
  if (bearer === 'vowel' && chars.includes(MACRON)) return null;

  if (chars.includes(GRAVE)) return 'low';
  if (chars.includes(ACUTE)) return 'high';
  // Marked mid (macron on a nasal) and unmarked mid (no mark at all) are the same claim,
  // written by people following different conventions.
  return 'mid';
}

/** The syllable with its tone mark removed and everything else kept - underdots
 * included, because those are letters (ẹ ọ ṣ are distinct phonemes), not tone.
 * This is what the "letters" box shows and edits. */
export function lettersOf(syllable: string): string {
  return [...syllable.normalize('NFD')]
    .filter((c) => !TONE_MARKS.has(c))
    .join('')
    .normalize('NFC');
}

/** Writes `tone` onto the syllable, replacing whatever mark was there.
 *
 * Returns the syllable untouched when nothing can carry tone, so a caller can run
 * this over every syllable of a word without special-casing Wiktionary's letter
 * entries.
 *
 * The mark is inserted directly after the bearer's base character and the result
 * NFC-normalised; NFC performs canonical reordering, so an underdot and a tone mark
 * on the same vowel end up in canonical order (ẹ + acute composes correctly)
 * regardless of the order they were spliced in. */
export function applyTone(syllable: string, tone: Tone): string {
  const bearer = toneBearerKind(syllable);
  if (bearer === null) return syllable;

  // Mid is idempotent: a syllable that ALREADY reads as mid comes back byte-identical,
  // whichever convention it was written in. Without this, `n` and `n̄` would both be
  // read as mid (correctly) and then both written as `n̄` - adding a macron to every
  // unmarked nasal that anyone merely looked at. That is not cosmetic: it produces a
  // `respell` nobody asked for, and the publish scripts compare recorded_syllables to
  // golden_record.syllables with exact equality, so it would silently drop that word's
  // recordings from the game.
  //
  // Deliberately changing a nasal TO mid still writes the macron, because then the
  // explicit form is what the reviewer chose.
  if (tone === 'mid' && toneOf(syllable) === 'mid') return syllable;

  return writeTone(syllable, tone, bearer);
}

/** applyTone without the mid-idempotence short-circuit: writes the EXPLICIT form of the tone even
 * when the syllable already reads that way.
 *
 * The short-circuit above exists so that merely looking at a word cannot edit it - an unmarked `n`
 * read as mid must come back as `n`, not `n̄`. But some acts are not incidental. Freeing a nasal
 * into a syllable of its own (nasalSplit.ts) is a reviewer asserting "this is a syllable", and the
 * macron is exactly how that assertion is written down - without it the new boundary would not be
 * re-derivable from the spelling, which is the property that whole flip depends on.
 *
 * So: applyTone for anything driven by the tone grid, this for a deliberate re-analysis. */
export function applyToneExplicitly(syllable: string, tone: Tone): string {
  const bearer = toneBearerKind(syllable);
  if (bearer === null) return syllable;
  return writeTone(syllable, tone, bearer);
}

function writeTone(syllable: string, tone: Tone, bearer: Exclude<ToneBearer, null>): string {
  const mark = tone === 'low' ? GRAVE : tone === 'high' ? ACUTE : bearer === 'nasal' ? MACRON : '';

  const chars = [...syllable.normalize('NFD')];
  const wanted = bearer === 'vowel' ? BASE_VOWELS : BASE_NASALS;
  const bearerIndex = chars.findIndex((c) => wanted.has(c.toLowerCase()));

  const out: string[] = [];
  chars.forEach((c, i) => {
    if (TONE_MARKS.has(c)) return; // drop any existing tone mark, wherever it sat
    out.push(c);
    if (i === bearerIndex && mark) out.push(mark);
  });
  return out.join('').normalize('NFC');
}

/** The tone of every syllable of a word, positionally. Null entries are syllables
 * with nothing to carry tone, or an under-marked syllabic nasal - see toneOf. */
export function tonesOf(syllables: string[]): Array<Tone | null> {
  return syllables.map(toneOf);
}

/** Rebuilds a word from syllables and a tone per syllable. The inverse of reading
 * a word into (syllables, tones), and the only way the review UI produces a
 * spelling - so a contributor can never submit a word whose syllables and letters
 * disagree with each other. */
export function applyTones(syllables: string[], tones: Array<Tone | null>): string[] {
  return syllables.map((syllable, i) => {
    const tone = tones[i];
    return tone === null || tone === undefined ? syllable : applyTone(syllable, tone);
  });
}

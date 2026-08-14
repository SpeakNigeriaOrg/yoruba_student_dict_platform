// screens/phraseWords.ts
//
// Splitting an authored spelling into tone-editable pieces.
//
// syllabifySpans deliberately refuses anything it cannot reproduce exactly - which includes
// every space, full stop and hyphen. So a spelling is handled piece by piece, and each piece
// is handled in three parts:
//
//     Ọ̀pọ̀lọ́   ń   fò.
//                    ^^ ^   core `fò`, trailing `.`
//
// The punctuation peel matters because the third kind of example is a short SENTENCE, and
// people write full stops. Without it `fò.` would refuse and lose its tone grid - the one
// word in the phrase most likely to carry a meaningful tone.
//
// If the core still refuses after peeling (an Ajami spelling), that piece's typed text stands
// VERBATIM and simply gets no grid. The composed spelling is therefore always exactly what the
// contributor can see, never a lossy re-rendering of it.
//
// ---------------------------------------------------------------------------
// A HYPHEN is a separator here, exactly like a space
// ---------------------------------------------------------------------------
// Not because the two mean the same thing - they do not - but because both are orthography
// sitting between tone-bearing units, and both make syllabifySpans refuse the whole string. A
// hyphen has two equally valid uses in Yoruba and this splitter serves both without needing to
// know which it is looking at:
//
//   compound          `ilé-ìwé` joins two words. The entry has components.
//   elongated nasal   `aárùn-ún` is one word; the hyphen is phonological. No components.
//
// Splitting on it is not cosmetic. The hyphen carries syllabification information that is
// otherwise ambiguous, which is why Wiktionary's Yoruba policy lemmatises the hyphenated form:
//
//   aárùn-ún   split on the hyphen  ->  a · á · rùn · ún
//   aárùnún    as one word          ->  a · á · rù · nún
//
// Different nasal attachment, and the hyphenated form is the one that says which. That is the
// same ambiguity 0016 exists to check against Wiktionary's IPA, so honouring the hyphen makes
// our split agree with the lemma instead of guessing.
//
// Measured before relying on it: 177 of 6,272 corpus headwords contain a hyphen, and 33 of
// those contain a space as well - so the two have to be handled together, not either/or.
//
// A trailing hyphen (a bound affix like `oní-`) yields an empty final piece. It gets no grid
// and contributes no syllables, and joinPhrase renders it as the empty string, so the hyphen
// still round-trips.

import { syllabifySpans } from '@yoruba-student-dict-platform/shared';

/** Characters peeled off the ends of a word before syllabifying.
 *
 * Deliberately not "anything the syllabifier rejects": that would silently peel a real
 * letter this project has not modelled yet and hide the problem. An explicit list of
 * punctuation fails visibly instead, by leaving the word verbatim. */
const PEELABLE = new Set(['.', ',', '!', '?', ';', ':', '"', "'", '(', ')', '’', '“', '”']);

/** One piece of a spelling: what lies between two separators, or the whole thing when there are
 * none. Still called a "word" because that is what it usually is - the hyphen cases are the
 * exception, and renaming the type would touch every caller for no gain in clarity. */
export interface PhraseWord {
  /** Everything before the syllabifiable core - usually empty, an opening quote at most. */
  leading: string;
  /** Syllables of the core, or null when it cannot be represented. */
  syllables: string[] | null;
  /** The core exactly as typed. Used when `syllables` is null, and to rebuild otherwise. */
  core: string;
  trailing: string;
}

function peel(word: string): { leading: string; core: string; trailing: string } {
  const chars = [...word];
  let start = 0;
  let end = chars.length;
  while (start < end && PEELABLE.has(chars[start])) start += 1;
  while (end > start && PEELABLE.has(chars[end - 1])) end -= 1;
  return {
    leading: chars.slice(0, start).join(''),
    core: chars.slice(start, end).join(''),
    trailing: chars.slice(end).join(''),
  };
}

/** Splits on runs of whitespace AND on hyphens, keeping the separators so the spelling can be
 * rebuilt with the contributor's own spacing and their own hyphens rather than a normalised
 * guess at either. See the header for why a hyphen belongs in the same rule as a space. */
export function splitPhrase(phrase: string): { words: PhraseWord[]; separators: string[] } {
  const pieces = phrase.split(/(\s+|-)/);
  const words: PhraseWord[] = [];
  const separators: string[] = [];

  pieces.forEach((piece, i) => {
    if (i % 2 === 1) {
      separators.push(piece);
      return;
    }
    const { leading, core, trailing } = peel(piece);
    words.push({ leading, core, trailing, syllables: core ? syllabifySpans(core) : null });
  });

  return { words, separators };
}

/** Rebuilds the phrase from its words, using each word's syllables where it has them and
 * its typed core where it does not. The single source of what gets submitted. */
export function joinPhrase(words: PhraseWord[], separators: string[]): string {
  return words
    .map((w) => w.leading + (w.syllables ? w.syllables.join('') : w.core) + w.trailing)
    .reduce((acc, text, i) => (i === 0 ? text : acc + (separators[i - 1] ?? ' ') + text), '');
}

/** Replaces one word's syllables, leaving everything else alone - what a ToneGrid's
 * onChange needs. */
export function withWordSyllables(words: PhraseWord[], index: number, syllables: string[]): PhraseWord[] {
  return words.map((w, i) => (i === index ? { ...w, syllables } : w));
}

/** Every syllable of an authored phrase, in order, flattened across its words.
 *
 * What golden_record.syllables holds for a phrase. It used to be the components' stored
 * syllables concatenated, which was only correct while a phrase was spelled exactly as its
 * parts - the assumption `o ṣé` breaks, and it broke the syllables the same way it broke the
 * spelling: the phrase inherited `ṣe` at mid tone from the component and the tone grid taught
 * a volunteer to record that.
 *
 * Reading them from the composed text instead keeps the two in step by construction, since the
 * composer's own grids are what produced that text. A word the syllabifier refuses (an Ajami
 * spelling, a hyphenated form) contributes itself as one unit, exactly as it is written, so the
 * list always accounts for every word on screen.
 *
 * Peeled punctuation is NOT restored here, unlike in joinPhrase: a syllable is a tone-bearing
 * unit that gets recorded and played on its own, and a full stop is not one. It only arises at
 * all because this splitter is shared with the example composer, where sentences are the point;
 * a dictionary phrase has none. */
export function phraseSyllables(words: PhraseWord[]): string[] {
  return words.flatMap((w) => {
    const whole = w.leading + w.core + w.trailing;
    if (w.core === '') return [];
    return w.syllables === null ? [whole] : w.syllables;
  });
}

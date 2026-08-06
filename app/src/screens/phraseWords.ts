// screens/phraseWords.ts
//
// Splitting an authored phrase into tone-editable pieces.
//
// A phrase is not a word, and syllabifySpans deliberately refuses anything it cannot
// reproduce exactly - which includes every space, full stop and hyphen. So a phrase is
// handled word by word, and each word is handled in three parts:
//
//     Ọ̀pọ̀lọ́   ń   fò.
//                    ^^ ^   core `fò`, trailing `.`
//
// The punctuation peel matters because the third kind of example is a short SENTENCE, and
// people write full stops. Without it `fò.` would refuse and lose its tone grid - the one
// word in the phrase most likely to carry a meaningful tone.
//
// If the core still refuses after peeling (an Ajami spelling, a hyphenated form like
// `gan-an`), that word's typed text stands VERBATIM and simply gets no grid. The composed
// phrase is therefore always exactly what the contributor can see, never a lossy
// re-rendering of it.

import { syllabifySpans } from '@yoruba-student-dict-platform/shared';

/** Characters peeled off the ends of a word before syllabifying.
 *
 * Deliberately not "anything the syllabifier rejects": that would silently peel a real
 * letter this project has not modelled yet and hide the problem. An explicit list of
 * punctuation fails visibly instead, by leaving the word verbatim. */
const PEELABLE = new Set(['.', ',', '!', '?', ';', ':', '"', "'", '(', ')', '’', '“', '”']);

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

/** Splits on runs of whitespace, keeping the separators so the phrase can be rebuilt with
 * the contributor's own spacing rather than a normalised single space. */
export function splitPhrase(phrase: string): { words: PhraseWord[]; separators: string[] } {
  const pieces = phrase.split(/(\s+)/);
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

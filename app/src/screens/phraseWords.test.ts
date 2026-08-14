import { describe, expect, it } from 'vitest';
import { joinPhrase, splitPhrase, withWordSyllables } from './phraseWords.js';

/** Round trip: whatever a contributor typed must come back out unchanged before they
 * touch anything. If this ever fails, the composer is silently rewriting phrases. */
function roundTrip(phrase: string): string {
  const { words, separators } = splitPhrase(phrase);
  return joinPhrase(words, separators);
}

describe('splitPhrase', () => {
  it('gives each word of a phrase its own syllables', () => {
    const { words } = splitPhrase('abo adiyẹ');
    expect(words.map((w) => w.syllables)).toEqual([
      ['a', 'bo'],
      ['a', 'di', 'yẹ'],
    ]);
  });

  it('handles the request\'s three example shapes', () => {
    expect(splitPhrase('kuule').words.map((w) => w.syllables)).toEqual([['ku', 'u', 'le']]);
    expect(splitPhrase('tọ bi ọpọlọ').words.map((w) => w.syllables)).toEqual([['tọ'], ['bi'], ['ọ', 'pọ', 'lọ']]);
    expect(splitPhrase('Opọlọ n fo').words.map((w) => w.syllables)).toEqual([['O', 'pọ', 'lọ'], ['n'], ['fo']]);
  });

  it('peels a full stop so a SENTENCE example still gets a tone grid on its last word', () => {
    // The word most likely to carry a meaningful tone is the one a full stop attaches to.
    const { words } = splitPhrase('Ọ̀pọ̀lọ́ ń fò.');
    expect(words[2]).toMatchObject({ core: 'fò', trailing: '.', syllables: ['fò'] });
  });

  it('peels commas, question marks and quotes from either end', () => {
    expect(splitPhrase('fo,').words[0]).toMatchObject({ core: 'fo', trailing: ',' });
    expect(splitPhrase('fo?').words[0]).toMatchObject({ core: 'fo', trailing: '?' });
    expect(splitPhrase('"fo"').words[0]).toMatchObject({ leading: '"', core: 'fo', trailing: '"' });
  });

  it('leaves a word it cannot represent verbatim, with no grid', () => {
    // Peeling is an explicit punctuation list, NOT "anything the syllabifier rejects" -
    // so an unmodelled form fails visibly here instead of being silently trimmed.
    // `شعِ` is a real corpus alternate spelling of `ṣe`, and genuinely has no syllable model.
    const { words } = splitPhrase('شعِ');
    expect(words[0].syllables).toBeNull();
    expect(words[0].core).toBe('شعِ');
  });

  it('splits on a hyphen, because a hyphen is a separator between tone-bearing units', () => {
    // This used to be the example of an unrepresentable form, which is what made every
    // hyphenated entry uneditable. Both of the hyphen's valid uses split the same way.
    expect(splitPhrase('gan-an').words.map((w) => w.core)).toEqual(['gan', 'an']);
    // A compound: the hyphen joins two words, and the entry has components.
    expect(splitPhrase('ilé-ìwé').words.map((w) => w.syllables)).toEqual([
      ['i', 'lé'],
      ['ì', 'wé'],
    ]);
    // An elongated nasal: one word, and the hyphen is what says where the nasal attaches.
    // Compare the unhyphenated spelling, which attaches it the other way.
    expect(splitPhrase('aárùn-ún').words.flatMap((w) => w.syllables ?? [])).toEqual(['a', 'á', 'rùn', 'ún']);
    expect(splitPhrase('aárùnún').words.flatMap((w) => w.syllables ?? [])).toEqual(['a', 'á', 'rù', 'nún']);
  });

  it('handles a hyphen and a space together, which 33 corpus headwords need', () => {
    const { words, separators } = splitPhrase('ilé-ìwé gíga');
    expect(words.map((w) => w.core)).toEqual(['ilé', 'ìwé', 'gíga']);
    expect(separators).toEqual(['-', ' ']);
  });

  it('gives a bound affix an empty trailing piece rather than losing its hyphen', () => {
    // `oní-` and `-kí-` are morphemes rather than words and should not become entries, but the
    // splitter must not mangle one if it meets it.
    const { words } = splitPhrase('oní-');
    expect(words.map((w) => w.core)).toEqual(['oní', '']);
    expect(words[1].syllables).toBeNull();
    expect(joinPhrase(words, splitPhrase('oní-').separators)).toBe('oní-');
  });
});

describe('joinPhrase round-trips what was typed', () => {
  for (const phrase of [
    'abo adiyẹ',
    'abo adìyẹ',
    'kuule',
    'kúulé',
    'tọ bi ọpọlọ',
    'tọ bí ọ̀pọ̀lọ́',
    'Opọlọ n fo',
    'Ọ̀pọ̀lọ́ ń fò',
    'Ọ̀pọ̀lọ́ ń fò.',
    'gan-an nìyẹn',
    'a  b',
  ]) {
    it(`leaves ${JSON.stringify(phrase)} unchanged`, () => {
      expect(roundTrip(phrase)).toBe(phrase.normalize('NFC'));
    });
  }

  it('preserves the contributor\'s own spacing rather than normalising it', () => {
    expect(roundTrip('abo   adiyẹ')).toBe('abo   adiyẹ');
  });

  it('survives an empty phrase and a trailing space', () => {
    expect(roundTrip('')).toBe('');
    expect(roundTrip('abo ')).toBe('abo ');
  });
});

describe('withWordSyllables', () => {
  it('replaces one word and leaves the rest alone', () => {
    const { words, separators } = splitPhrase('Opọlọ n fo');
    const next = withWordSyllables(words, 1, ['ń']);
    expect(joinPhrase(next, separators)).toBe('Opọlọ ń fo');
  });

  it('composes the fully-marked phrase from the plain one, one word at a time', () => {
    // The whole point of the composer: a contributor types ASCII plus ẹ ọ ṣ and never a
    // diacritic, and the tone grids generate the marks.
    let { words } = splitPhrase('Opọlọ n fo');
    const { separators } = splitPhrase('Opọlọ n fo');
    words = withWordSyllables(words, 0, ['Ọ̀', 'pọ̀', 'lọ́']);
    words = withWordSyllables(words, 1, ['ń']);
    words = withWordSyllables(words, 2, ['fò']);
    expect(joinPhrase(words, separators)).toBe('Ọ̀pọ̀lọ́ ń fò'.normalize('NFC'));
  });
});

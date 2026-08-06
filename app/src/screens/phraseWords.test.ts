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
    const { words } = splitPhrase('gan-an');
    expect(words[0].syllables).toBeNull();
    expect(words[0].core).toBe('gan-an');
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

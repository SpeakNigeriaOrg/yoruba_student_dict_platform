import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchVocab } from './vocabSearch';
import type { Vocab } from './types';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const vocab = loadFixture<Vocab>('raw_vocab.json');

interface SearchVocabFixture {
  query: string;
  results: unknown[];
}

const fixtures = loadFixture<SearchVocabFixture[]>('search_vocab.json');

describe('searchVocab (parity with vocab_search.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`query ${JSON.stringify(fixture.query)}: matches the Python engine's results, in order`, () => {
      expect(searchVocab(vocab, fixture.query)).toEqual(fixture.results);
    });
  }
});

describe('searchVocab direct unit tests', () => {
  it('returns an empty list for a blank query', () => {
    expect(searchVocab(vocab, '')).toEqual([]);
  });

  it('falls back to a word_id substring match when no spelling tier matches', () => {
    // "moto_automobile"'s word_id contains "ile" (the tail of
    // "automobile") even though its displayText "mọ́tò" doesn't match any
    // spelling tier for the query "ile".
    const results = searchVocab(vocab, 'ile');
    expect(results.some((r) => r.wordId === 'moto_automobile' && r.matchedVia === 'word_id')).toBe(true);
  });
});

describe('affixes answer to their spelling without the hyphen', () => {
  const affixes: Vocab = {
    o_word: { displayText: 'o', syllables: ['o'], definition: 'you' },
    o_prefix: { displayText: 'o-', syllables: ['o'], definition: 'nominalizing prefix' },
    o_low_prefix: { displayText: 'ò-', syllables: ['ò'], definition: 'nominalizing prefix' },
    o_dot_prefix: { displayText: 'ọ-', syllables: ['ọ'], definition: 'nominalizing prefix' },
    ola_suffix: { displayText: '-ọlá', syllables: ['ọ', 'lá'], definition: 'honour' },
    ni_interfix: { displayText: '-ní-', syllables: ['ní'], definition: 'interfix' },
  };

  it('"o" finds the o- prefixes, each after the word spelled the same at its tier', () => {
    // The word_id tier (ola_suffix contains an o) is not what this is about.
    const spelled = searchVocab(affixes, 'o').filter((r) => r.matchedVia !== 'word_id');
    expect(spelled.map((r) => [r.displayText, r.matchedVia])).toEqual([
      ['o', 'yoruba_exact'],
      ['o-', 'yoruba_exact'],
      ['ò-', 'yoruba_tone'],
      ['ọ-', 'yoruba_ortho'],
    ]);
  });

  it('works for suffixes and interfixes too', () => {
    expect(searchVocab(affixes, 'ola')[0]).toMatchObject({ displayText: '-ọlá', matchedVia: 'yoruba_ortho' });
    expect(searchVocab(affixes, 'ní')[0]).toMatchObject({ displayText: '-ní-', matchedVia: 'yoruba_exact' });
  });
});

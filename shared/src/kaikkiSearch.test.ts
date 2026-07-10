import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, searchKaikki } from './kaikkiSearch';
import type { KaikkiLexicon } from './types';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const lexicon = loadFixture<KaikkiLexicon>('raw_kaikki_lexicon.json');
const records = buildSearchIndex(lexicon);

interface SearchKaikkiFixture {
  query: string;
  results: unknown[];
}

const fixtures = loadFixture<SearchKaikkiFixture[]>('search_kaikki.json');

describe('searchKaikki (parity with kaikki_search.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`query ${JSON.stringify(fixture.query)}: matches the Python engine's results, in order`, () => {
      expect(searchKaikki(records, fixture.query)).toEqual(fixture.results);
    });
  }
});

describe('searchKaikki direct unit tests', () => {
  it('returns an empty list for a blank query', () => {
    expect(searchKaikki(records, '   ')).toEqual([]);
  });

  it('respects the limit parameter', () => {
    expect(searchKaikki(records, 'ile', 2)).toHaveLength(2);
  });

  it('ranks Yoruba tiers above English matches even when an English query would also match', () => {
    const results = searchKaikki(records, 'ile');
    const firstEnglishIndex = results.findIndex((r) => r.matchedVia === 'english');
    const lastYorubaIndex = results.map((r) => r.matchedVia).lastIndexOf('yoruba_prefix');
    if (firstEnglishIndex !== -1 && lastYorubaIndex !== -1) {
      expect(lastYorubaIndex).toBeLessThan(firstEnglishIndex);
    }
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, searchKaikki } from './kaikkiSearch';
import type { KaikkiLexicon, KaikkiSense } from './types';

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

/** These fixtures assert PARITY with kaikki_search.py: which senses are found,
 * ranked in what order. entryId/etymologyNumber have no Python counterpart -
 * they carry the citation this engine added - so they are not part of that
 * contract and are dropped before comparing. Their own behaviour is covered by
 * the 'carries the citation' block below, not here. */
function withoutCitation(results: ReturnType<typeof searchKaikki>): unknown[] {
  return results.map(({ entryId: _entryId, etymologyNumber: _etymologyNumber, ...rest }) => rest);
}

describe('searchKaikki (parity with kaikki_search.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`query ${JSON.stringify(fixture.query)}: matches the Python engine's results, in order`, () => {
      expect(withoutCitation(searchKaikki(records, fixture.query))).toEqual(fixture.results);
    });
  }
});

/** The three real `kọ́` etymologies, which is the case the whole citation model
 * exists for: one spelling, three unrelated words. */
function sense(over: Partial<KaikkiSense> & { glosses: string[] }): KaikkiSense {
  return {
    pos: 'verb',
    etymologyNumber: null,
    headword: 'kọ́',
    canonicalForm: { value: 'kọ́', inferenceMethod: 'test', confidence: 1, originalValue: 'kọ́' },
    standardForms: ['kọ́'],
    altOfTargets: [],
    componentCandidates: [],
    derivedForms: [],
    ...over,
  };
}

describe('searchKaikki carries the citation (an entry IS a Wiktionary etymology)', () => {
  const ko = [
    sense({ entryId: 'en-ko-yo-verb-BUILD', etymologyNumber: '2', glosses: ['to build, construct', 'to learn, teach'] }),
    sense({ entryId: 'en-ko-yo-particle-NEG', etymologyNumber: '3', pos: 'particle', glosses: ['a negation particle'] }),
    sense({ entryId: 'en-ko-yo-verb-HANG', etymologyNumber: '4', glosses: ['to hang, suspend'] }),
  ];
  const koRecords = buildSearchIndex({ ko: ko });

  it('reports which etymology each result is, so the picker can tell them apart', () => {
    const results = searchKaikki(koRecords, 'kọ́');
    expect(results.map((r) => [r.entryId, r.etymologyNumber])).toEqual(
      expect.arrayContaining([
        ['en-ko-yo-verb-BUILD', '2'],
        ['en-ko-yo-particle-NEG', '3'],
        ['en-ko-yo-verb-HANG', '4'],
      ]),
    );
  });

  it('returns all three rather than collapsing a shared spelling into one', () => {
    expect(searchKaikki(koRecords, 'kọ́')).toHaveLength(3);
  });

  it('collapses ONE etymology cross-indexed under several spellings, even after a JSON round trip', () => {
    const one = sense({ entryId: 'en-ko-yo-verb-HANG', glosses: ['to hang, suspend'], standardForms: ['kọ́', 'ko'] });
    // The lexicon lists the same record under every spelling it is known by;
    // a JSON round trip makes those separate-but-equal objects.
    const roundTripped: KaikkiSense = JSON.parse(JSON.stringify(one));
    const results = searchKaikki(buildSearchIndex({ ko: [one, roundTripped] }), 'kọ́');
    expect(results).toHaveLength(1);
    expect(results[0].entryId).toBe('en-ko-yo-verb-HANG');
  });

  it('keeps two etymologies that agree on form, pos AND glosses apart - the content key could not', () => {
    // Real in the corpus (3 word+pos groups have colliding id suffixes). Under
    // the old content key one of these vanished from the picker silently.
    const twins = [
      sense({ entryId: 'en-ko-yo-verb-ONE', etymologyNumber: '1', glosses: ['to break'] }),
      sense({ entryId: 'en-ko-yo-verb-TWO', etymologyNumber: '5', glosses: ['to break'] }),
    ];
    expect(searchKaikki(buildSearchIndex({ ko: twins }), 'kọ́')).toHaveLength(2);

    // And documents what the pre-0014 fallback does instead: without ids there
    // is nothing to tell them apart by, so they still collapse.
    const idless = twins.map((s) => ({ ...s, entryId: null }));
    expect(searchKaikki(buildSearchIndex({ ko: idless }), 'kọ́')).toHaveLength(1);
  });
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

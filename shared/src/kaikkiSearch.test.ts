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

/** Queries where the English RANKING deliberately no longer matches kaikki_search.py.
 *
 * The Python engine scores an English query by counting how many times its words appear across all
 * of a sense's glosses glued together. That rewards verbosity, and it is why searching "child" put
 * `ọmọ` third behind a paragraph about a spirit reborn as a child, and why this fixture pins `ilé`
 * at index 5 for "house". englishRelevance.ts replaces it - see that file for the measurements.
 *
 * Named rather than re-snapshotted, and asserted from BOTH sides, so a future accidental change to
 * the ranking cannot hide inside an updated blob. The Yoruba tiers are untouched and still hold
 * byte-for-byte parity, which is most of what this fixture set is for. */
const ENGLISH_RANKING_DIVERGENCES: Record<string, { pythonTop: string; oursTop: string; why: string }> = {
  // Python put `ọwá` ("the parlor or inner courtyard of a home") first and `ilé` at index 5, purely
  // on gloss-word count. We put `òrùlé` first, whose glosses are ["roof (of a house)", "house"] -
  // Wiktionary does list "house" as a sense of it - and `ilé` third.
  //
  // Not the answer a learner would pick, and deliberately not tuned further. A primary-sense
  // weighting was prototyped to lift `ilé`: measured, it made the 18-query mean rank WORSE
  // (2.8 -> 3.4) and still did not put `ilé` first - a dialect form `ulí` won instead. Overfitting
  // the ranking to one fixture query is how a search engine ends up worse everywhere else. On the
  // full production corpus (5,580 forms rather than this fixture's snapshot) `ilé` ranks third.
  house: {
    pythonTop: 'ọwá',
    oursTop: 'òrùlé',
    why: 'the Python engine ranked by raw gloss-word count, which put the obvious word at index 5',
  },
};

describe('searchKaikki (parity with kaikki_search.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures.filter((f) => !(f.query in ENGLISH_RANKING_DIVERGENCES))) {
    it(`query ${JSON.stringify(fixture.query)}: matches the Python engine's results, in order`, () => {
      expect(withoutCitation(searchKaikki(records, fixture.query))).toEqual(fixture.results);
    });
  }

  for (const [query, divergence] of Object.entries(ENGLISH_RANKING_DIVERGENCES)) {
    it(`query ${JSON.stringify(query)}: deliberately diverges - ${divergence.why}`, () => {
      const fixture = fixtures.find((f) => f.query === query);
      expect(fixture, `${query} is no longer in the fixture set`).toBeDefined();

      // Both sides asserted: the fixture still records what Python did, and we now do the
      // documented different thing.
      expect((fixture!.results[0] as { form: string }).form).toBe(divergence.pythonTop);
      expect(searchKaikki(records, query)[0].form).toBe(divergence.oursTop);

      // Same SET of senses, reordered - the change is to ranking, not to matching.
      const ours = new Set(searchKaikki(records, query, 500).map((r) => r.form));
      for (const result of fixture!.results as Array<{ form: string }>) {
        expect(ours, `${result.form} dropped out of the results entirely`).toContain(result.form);
      }
    });
  }

  it('diverges from the Python engine on exactly the documented queries and no others', () => {
    // The count is the point: a ranking change that quietly moved a Yoruba-tier query would show up
    // here rather than as one more edited fixture.
    const diverging = fixtures
      .filter((f) => JSON.stringify(withoutCitation(searchKaikki(records, f.query))) !== JSON.stringify(f.results))
      .map((f) => f.query);
    expect(diverging.sort()).toEqual(Object.keys(ENGLISH_RANKING_DIVERGENCES).sort());
  });
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

// ---------------------------------------------------------------------------
// English relevance: the "child" bug
// ---------------------------------------------------------------------------
// Searching "child" put `ọmọ` third, behind a paragraph about a spirit reborn as a child, because
// the score was a raw count of the query's words across all glosses glued together. These use small
// hand-built lexicons so the property under test is visible, rather than inferring it from a corpus
// snapshot.

function lexiconOf(entries: Array<{ form: string; glosses: string[]; parts?: string[] }>): KaikkiLexicon {
  const lexicon: KaikkiLexicon = {};
  for (const [i, entry] of entries.entries()) {
    const sense = {
      entryId: `test-${i}`,
      pos: 'noun',
      etymologyNumber: null,
      etymologyText: null,
      headword: entry.form,
      canonicalForm: { value: entry.form, inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: entry.form },
      standardForms: [entry.form],
      glosses: entry.glosses,
      altOfTargets: [],
      componentCandidates: (entry.parts ?? []).map((form) => ({ form, provenance: 'etymology_template' })),
      usedInCandidates: [],
      derivedFormTexts: [],
    } as unknown as KaikkiSense;
    lexicon[`k${i}`] = [sense];
  }
  return lexicon;
}

const search = (entries: Parameters<typeof lexiconOf>[0], query: string) =>
  searchKaikki(buildSearchIndex(lexiconOf(entries)), query, 50).map((r) => r.form);

describe('a gloss that IS the query beats one that merely mentions it', () => {
  it('puts the word whose whole gloss is the query first', () => {
    // The reported bug, reduced: a long ethnographic gloss saying "child" repeatedly used to beat
    // the word whose gloss is the single word "child".
    expect(
      search(
        [
          { form: 'àbíkú', glosses: ['a spirit that causes a child to die, is born again as a child, and dies as a child'] },
          { form: 'ọmọ', glosses: ['child; offspring'] },
        ],
        'child',
      )[0],
    ).toBe('ọmọ');
  });

  it('no longer rewards repetition', () => {
    expect(
      search(
        [
          { form: 'verbose', glosses: ['a house beside a house behind a house near a house'] },
          { form: 'ilé', glosses: ['house'] },
        ],
        'house',
      )[0],
    ).toBe('ilé');
  });

  it('counts a clause of a multi-sense gloss, not only a whole-gloss match', () => {
    // Glosses are usually lists of near-synonyms, so the unit that can equal a query is the clause.
    expect(search([{ form: 'ọ̀nà', glosses: ['path, way, road'] }, { form: 'other', glosses: ['a road surface'] }], 'road')[0]).toBe('ọ̀nà');
  });

  it('scores a word with many senses on its BEST gloss, not on all of them pooled', () => {
    // yorubadict's failure mode: dividing by a pooled document punished a word for being important.
    // The many-sense word here must still win on the strength of its "child" gloss alone.
    const many = { form: 'ọmọ', glosses: ['child', 'offspring', 'young of an animal', 'a native of a place', 'member of a group'] };
    expect(search([{ form: 'rare', glosses: ['a small child seat'] }, many], 'child')[0]).toBe('ọmọ');
  });
});

describe('the root bonus lifts a productive word, and only where it applies', () => {
  it('lifts a root when other MATCHING words are built from it', () => {
    const entries = [
      { form: 'ọmọdé', glosses: ['child'], parts: ['ọmọ'] },
      { form: 'ọmọ', glosses: ['child'] },
      { form: 'ọmọkọ́mọ', glosses: ['naughty child'], parts: ['ọmọ'] },
    ];
    // All three gloss as "child"; ọmọ wins because the other two are built out of it.
    expect(search(entries, 'child')[0]).toBe('ọmọ');
  });

  it('does NOT lift a root that the query did not itself match', () => {
    // The safety property. `ọmọ` is the root of `ọmọlan̄ke`, but nothing about `ọmọ` means
    // "wheelbarrow", so it must not appear at all - otherwise every productive prefix would be
    // dragged to the top of every search.
    const results = search(
      [
        { form: 'ọmọlan̄ke', glosses: ['wheelbarrow'], parts: ['ọmọ'] },
        { form: 'ọmọ', glosses: ['child'] },
      ],
      'wheelbarrow',
    );
    expect(results).toEqual(['ọmọlan̄ke']);
  });

  it('is minor: it cannot outrank a word whose gloss IS the query', () => {
    // Damped and capped on purpose. A root with many derivatives still loses to an exact meaning.
    const entries = [
      { form: 'exact', glosses: ['child'] },
      { form: 'root', glosses: ['relating to a child in some way'] },
      ...Array.from({ length: 12 }, (_, i) => ({ form: `rootword${i}`, glosses: ['a child thing'], parts: ['root'] })),
    ];
    expect(search(entries, 'child')[0]).toBe('exact');
  });
});

describe('ties break on gloss length, not on position in the corpus file', () => {
  it('prefers the terser gloss when scores are equal', () => {
    // `Àjàyí` beat `ọmọ` for "child" purely by sitting earlier in the lexicon JSON.
    const [first] = search(
      [
        { form: 'earlier', glosses: ['a child, and also a great many other things besides, at length'] },
        { form: 'terser', glosses: ['a child'] },
      ],
      'child',
    );
    expect(first).toBe('terser');
  });
});

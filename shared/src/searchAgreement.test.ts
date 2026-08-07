// Cross-engine agreement.
//
// yorubadict and this platform share the four Yoruba orthography tiers as a real port, but their
// English halves had drifted into two different algorithms with two different failure modes - and
// nothing tested them against each other. "child" was buried at #3 here (no length normalisation,
// so verbose glosses won) and #35 there (BM25 over a pooled per-entry document, so a word was
// penalised for having many senses). One symptom, two causes, neither caught.
//
// fixtures/search_agreement.json is checked in both repos. It is deliberately NOT full parity - the
// two differ on limit, result granularity, the diacritic guard, the dialect tier and whether example
// sentences are indexed. What they must agree on is which word an English query is ABOUT.
//
// This runs against the LEXICON FIXTURE rather than production, so it needs no database. That means
// it is a snapshot of the corpus, and a query whose answer depends on data added since will drift -
// which is why the assertions are "top result" / "top three" rather than exact arrays.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, searchKaikki } from './kaikkiSearch';
import type { KaikkiLexicon } from './types';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const load = <T,>(name: string): T => JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));

const records = buildSearchIndex(load<KaikkiLexicon>('raw_kaikki_lexicon.json'));

interface AgreementFixture {
  expectedTopResult: Array<{ query: string; form: string; note?: string }>;
  expectedInTopThree: Array<{ query: string; form: string; note?: string }>;
  rootBonusMustNotPromote: Array<{ query: string; mustNotContain: string; note?: string }>;
}
const fixture = load<AgreementFixture>('search_agreement.json');

const nfc = (s: string) => s.normalize('NFC');
const formsFor = (query: string, limit = 40) => searchKaikki(records, query, limit).map((r) => nfc(r.form));

describe('English queries surface the word they are about', () => {
  it('has cases to check', () => {
    expect(fixture.expectedTopResult.length).toBeGreaterThan(0);
  });

  for (const { query, form } of fixture.expectedTopResult) {
    it(`"${query}" -> ${form} first`, () => {
      const forms = formsFor(query);
      // The failure message matters here: seeing what DID win is the whole diagnostic.
      expect(forms[0], `got ${forms.slice(0, 5).join(', ')}`).toBe(nfc(form));
    });
  }

  for (const { query, form } of fixture.expectedInTopThree) {
    it(`"${query}" -> ${form} in the top three`, () => {
      const forms = formsFor(query);
      expect(forms.slice(0, 3), `got ${forms.slice(0, 5).join(', ')}`).toContain(nfc(form));
    });
  }
});

describe('the root bonus never promotes a word the query did not match', () => {
  // The property that keeps it minor. Without it, every productive root would be dragged into every
  // search for anything derived from it.
  for (const { query, mustNotContain } of fixture.rootBonusMustNotPromote) {
    it(`"${query}" does not surface ${mustNotContain}`, () => {
      expect(formsFor(query, 100)).not.toContain(nfc(mustNotContain));
    });
  }
});

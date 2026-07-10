import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPossibleDuplicates } from './duplicateCheck';
import type { DiagnosticsOverrides, KaikkiLexicon, Vocab } from './types';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const vocab = loadFixture<Vocab>('raw_vocab.json');
const lexicon = loadFixture<KaikkiLexicon>('raw_kaikki_lexicon.json');
const overrides = loadFixture<DiagnosticsOverrides>('raw_overrides.json');

interface DuplicateCheckFixture {
  name: string;
  candidateSpelling: string;
  candidateAltOfTargets: string[];
  matches: unknown[];
}

const fixtures = loadFixture<DuplicateCheckFixture[]>('duplicate_check.json');

describe('findPossibleDuplicates (parity with duplicate_check.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}`, () => {
      const actual = findPossibleDuplicates(
        fixture.candidateSpelling,
        fixture.candidateAltOfTargets,
        vocab,
        lexicon,
        overrides,
      );
      expect(actual).toEqual(fixture.matches);
    });
  }

  // Spelled out explicitly (already covered by the fixture loop above) so
  // the specific case this guards against - false-flagging unrelated
  // homograph senses that merely share a base spelling - doesn't get lost
  // in a generic parametrized loop.
  it('never flags unrelated homograph senses (e.g. "owo") that merely share a base spelling', () => {
    const result = findPossibleDuplicates('owó', [], vocab, lexicon, overrides);
    expect(result).toEqual([]);
  });
});

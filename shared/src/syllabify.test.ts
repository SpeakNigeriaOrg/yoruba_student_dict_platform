import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { syllabifyWord } from './syllabify';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

interface SyllabifyFixture {
  wordId: string;
  displayText: string;
  expectedSyllables: string[];
  computedSyllables: string[] | null;
}

const fixtures: SyllabifyFixture[] = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'syllabify.json'), 'utf8'),
);

describe('syllabifyWord (parity with syllabify.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // Parity with the PYTHON ENGINE's own computed output, not necessarily
  // with vocab.json's hand-curated expectedSyllables - syllabify.py itself
  // isn't a perfect match to the hand-curated breakdown for every word
  // (that's the whole reason generate_diagnostics.py's syllable-split axis
  // exists as a human-reviewed check, not an auto-correction). This test's
  // job is narrower: does the TS port compute the exact same thing the
  // Python original does for the same input.
  const parityCases = fixtures.filter((f) => f.computedSyllables !== null);

  it('has multi-word (phrase) entries correctly excluded from parity cases, same as the Python export', () => {
    const skipped = fixtures.filter((f) => f.computedSyllables === null);
    for (const f of skipped) {
      expect(f.displayText).toMatch(/\s/);
    }
  });

  for (const fixture of parityCases) {
    it(`matches the Python engine's syllabification for ${fixture.wordId} (${JSON.stringify(fixture.displayText)})`, () => {
      expect(syllabifyWord(fixture.displayText)).toEqual(fixture.computedSyllables);
    });
  }
});

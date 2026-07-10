import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allForms } from './orthography';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

interface OrthographyFixture {
  input: string;
  exact: string;
  toneInsensitive: string;
  orthographyInsensitive: string;
}

const fixtures: OrthographyFixture[] = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'orthography.json'), 'utf8'),
);

describe('orthography (parity with yoruba_orthography.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`matches the Python engine's output for ${JSON.stringify(fixture.input)}`, () => {
      expect(allForms(fixture.input)).toEqual({
        exact: fixture.exact,
        toneInsensitive: fixture.toneInsensitive,
        orthographyInsensitive: fixture.orthographyInsensitive,
      });
    });
  }

  // Named regression cases from REMOTE_ACCESS_DISCUSSION.md §4 - these are
  // already covered by the fixture loop above, but spelled out explicitly
  // here so the specific bug each one caught doesn't get lost in a generic
  // parametrized loop.
  it('keeps owó (money, no underdots) and ọwọ́ (hand, underdotted) distinct at the tone-insensitive tier', () => {
    expect(allForms('owó').toneInsensitive).not.toBe(allForms('ọwọ́').toneInsensitive);
  });

  it('collapses owó and ọwọ́ only at the fully orthography-insensitive tier (the tier that must never be used for confident matching)', () => {
    expect(allForms('owó').orthographyInsensitive).toBe(allForms('ọwọ́').orthographyInsensitive);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allForms, wiktionaryPageTitle } from './orthography';

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

describe('wiktionaryPageTitle', () => {
  // Wiktionary's Yoruba policy: underdots and ṣ belong in the page title, tones belong in the
  // headword line. So a title is the spelling minus every tone mark, and nothing else.
  it('keeps the underdots and drops the tones', () => {
    expect(wiktionaryPageTitle('ọwọ́')).toBe('ọwọ');
    expect(wiktionaryPageTitle('ẹ jọ̀ọ́')).toBe('ẹ jọọ');
    expect(wiktionaryPageTitle('adìyẹ')).toBe('adiyẹ');
  });

  it('keeps ṣ, which the policy names explicitly', () => {
    expect(wiktionaryPageTitle('o ṣé')).toBe('o ṣe');
  });

  it('drops the macron, because a macron marks a tone', () => {
    // An ambiguous mid-tone nasal is written with a macron, and the policy puts tone marking in
    // the headword line - so `gban̄gba` and `gbangba` share one page.
    expect(wiktionaryPageTitle('gban̄gba')).toBe('gbangba');
  });

  it('preserves case, unlike the tone-insensitive lookup key', () => {
    // The reason this is a separate function. toneInsensitiveForm lowercases because it builds a
    // key where case is noise; a page title is a name, and Ṣóyínká is a person.
    expect(wiktionaryPageTitle('Ṣóyínká')).toBe('Ṣoyinka');
    expect(allForms('Ṣóyínká').toneInsensitive).toBe('ṣoyinka');
  });

  it('keeps a hyphen, since the hyphenated form is the lemma', () => {
    // Policy: "For elongated nasal vowels, the standard form with a dash should be the
    // lemmatized one" - so the hyphen is part of the title, not decoration to strip.
    expect(wiktionaryPageTitle('aárùn-ún')).toBe('aarun-un');
    expect(wiktionaryPageTitle('ilé-ìwé')).toBe('ile-iwe');
  });
});

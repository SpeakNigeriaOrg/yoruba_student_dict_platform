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

/** Forms where this port DELIBERATELY diverges from syllabify.py, each with its reason.
 *
 * Named here rather than edited into the fixture on purpose. The parity suite's whole value is
 * that a side-by-side diff against the Python original stays meaningful, and a quietly-updated
 * expectation reads as the port drifting rather than as a rule being fixed. */
const DELIBERATE_DIVERGENCES: Record<string, { python: string[]; ours: string[]; why: string }> = {
  // Plain `o` does not nasalise in Yoruba, so `on` here cannot be a coda - the nasal must be its
  // own syllable. The Python engine absorbs it regardless.
  //
  // This is the one form in the whole 5,580-form corpus the nasalisable-vowel rule fires on, and
  // it fires on a word we already know is malformed: production stores its split as
  // ['à','gùn','fọn'] (underdotted ọ, which DOES nasalise) while its display_text says `àgùnfon`,
  // and upstream Wiktionary has `àgùnfọn`. So the rule diagnoses the typo from a second direction
  // rather than re-analysing a healthy word. Fixing the spelling is a human call and is not this
  // suite's business; when it is fixed, this entry goes away and the parity loop covers it again.
  agunfon_giraffe: {
    python: ['à', 'gùn', 'fon'],
    ours: ['à', 'gùn', 'fo', 'n'],
    why: 'plain `o` cannot carry a nasal coda, so `n` is syllabic (the word is a known typo for àgùnfọn)',
  },
};

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

  for (const fixture of parityCases.filter((f) => !(f.wordId in DELIBERATE_DIVERGENCES))) {
    it(`matches the Python engine's syllabification for ${fixture.wordId} (${JSON.stringify(fixture.displayText)})`, () => {
      expect(syllabifyWord(fixture.displayText)).toEqual(fixture.computedSyllables);
    });
  }

  // The divergences are asserted from BOTH sides: that the fixture still records what Python
  // computed, and that we now compute the documented different thing. Either drifting fires.
  for (const [wordId, divergence] of Object.entries(DELIBERATE_DIVERGENCES)) {
    it(`deliberately diverges from the Python engine for ${wordId}: ${divergence.why}`, () => {
      const fixture = fixtures.find((f) => f.wordId === wordId);
      expect(fixture, `${wordId} is no longer in the fixture - remove its divergence entry`).toBeDefined();
      expect(fixture!.computedSyllables).toEqual(divergence.python);
      expect(syllabifyWord(fixture!.displayText)).toEqual(divergence.ours);
    });
  }

  // -------------------------------------------------------------------------
  // The two rules that decide a nasal without asking anyone
  // -------------------------------------------------------------------------
  // Yoruba writes three syllable types - CV, V and N - and a nasal after a vowel is either a coda
  // nasalising that vowel or a syllable of its own. These are the cases the letters settle. What
  // is left genuinely ambiguous keeps the coda reading, which agrees with Wiktionary's own IPA on
  // 3,993 of 3,996 forms.

  describe('only a ẹ i ọ u can carry a nasal coda - plain e and o cannot', () => {
    it.each([
      ['a', 'kan', ['kan']],
      ['i', 'rin', ['rin']],
      ['u', 'run', ['run']],
      ['ẹ', 'ṣẹn', ['ṣẹn']],
      ['ọ', 'gbọn', ['gbọn']],
    ])('absorbs the nasal after %s (%s)', (_vowel, word, expected) => {
      expect(syllabifyWord(word)).toEqual(expected);
    });

    it.each([
      ['e', 'ken', ['ke', 'n']],
      ['o', 'kon', ['ko', 'n']],
    ])('splits the nasal off after plain %s (%s), which cannot be nasalised', (_vowel, word, expected) => {
      expect(syllabifyWord(word)).toEqual(expected);
    });

    it('is decided by the underdot, not the base letter: ẹn absorbs where en does not', () => {
      // The two differ by one combining mark, and after NFD they share a base character - so a
      // set of precomposed vowels would have matched neither.
      expect(syllabifyWord('ken')).toEqual(['ke', 'n']);
      expect(syllabifyWord('kẹn')).toEqual(['kẹn']);
    });

    it('still treats a following vowel as making the nasal an ONSET, not a coda', () => {
      // `ni` is n + i, so there is nothing to absorb regardless of the preceding vowel.
      expect(syllabifyWord('ani')).toEqual(['a', 'ni']);
    });
  });

  describe('a coda nasal is written m before b/p, and only there', () => {
    it('absorbs a bare m before b', () => {
      // The homorganic rule: "The letter m is also a nasal vowel. However, it is only used for the
      // letters b and p." So this is as ambiguous as `n` elsewhere, and must be absorbable.
      expect(syllabifyWord('jamba')).toEqual(['jam', 'ba']);
    });

    it('absorbs a bare m before p', () => {
      // `ọ`, not `o` - the real word is `kọ̀mpútà`.
      expect(syllabifyWord('kọmpu')).toEqual(['kọm', 'pu']);
    });

    it('defers to the vowel rule: plain o + m before p is still split, because o cannot nasalise', () => {
      // The two rules compose, and the vowel one wins. Worth pinning: `kompu` looks like the case
      // above and is not, and getting this backwards would absorb a nasal onto a vowel that
      // cannot carry one.
      expect(syllabifyWord('kompu')).toEqual(['ko', 'm', 'pu']);
    });

    it('leaves m before a non-labial as its own syllable, where no coda m is licensed', () => {
      expect(syllabifyWord('amta')).toEqual(['a', 'm', 'ta']);
    });

    it('leaves a word-final m as its own syllable', () => {
      expect(syllabifyWord('am')).toEqual(['a', 'm']);
    });

    it('keeps a TONED m syllabic even before a labial - the mark is what says so', () => {
      // Every m+labial form in the corpus is marked like this, and Wiktionary's IPA transcribes
      // all 17 as a standalone /ŋ/ syllable.
      expect(syllabifyWord('jàm̀bá')).toEqual(['jà', 'm̀', 'bá']);
    });

    it('keeps a toned n syllabic, unchanged from before', () => {
      expect(syllabifyWord('aláǹgbá')).toEqual(['a', 'lá', 'ǹ', 'gbá']);
      expect(syllabifyWord('gban̄gba')).toEqual(['gba', 'n̄', 'gba']);
    });

    it('still reads an unmarked n before a consonant as a coda - the ambiguous default', () => {
      expect(syllabifyWord('alangba')).toEqual(['a', 'lan', 'gba']);
    });
  });

  it('diverges from the Python engine on exactly the documented forms and no others', () => {
    // The count is the point: a rule change that quietly re-analysed a second word would show up
    // here rather than as one more edited expectation.
    const diverging = parityCases.filter(
      (f) => JSON.stringify(syllabifyWord(f.displayText)) !== JSON.stringify(f.computedSyllables),
    );
    expect(diverging.map((f) => f.wordId).sort()).toEqual(Object.keys(DELIBERATE_DIVERGENCES).sort());
  });
});

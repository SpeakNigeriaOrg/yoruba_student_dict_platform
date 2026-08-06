import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { absorbNasalAt, canAbsorbNasal, canFreeNasal, freeNasalAt } from './nasalSplit';
import { syllabifyWord } from './syllabify';

describe('freeNasalAt', () => {
  it('frees an absorbed nasal into its own syllable, marked mid', () => {
    // The macron is the point, not decoration: it is what makes the new split re-derivable from
    // the new spelling, so nothing has to store a boundary the letters do not imply.
    expect(freeNasalAt(['a', 'lan', 'gba'], 1)).toEqual(['a', 'la', 'n̄', 'gba']);
  });

  it('produces a split that re-derives to itself, which is the whole invariant', () => {
    const freed = freeNasalAt(['a', 'lan', 'gba'], 1)!;
    expect(syllabifyWord(freed.join(''))).toEqual(freed);
  });

  it('preserves capitalisation, so a proper noun is not quietly lowercased', () => {
    expect(freeNasalAt(['Lan', 'gba'], 0)).toEqual(['La', 'n̄', 'gba']);
  });

  it('frees a coda m before a labial', () => {
    expect(freeNasalAt(['jam', 'ba'], 0)).toEqual(['ja', 'm̄', 'ba']);
  });

  it('returns null where there is no absorbed nasal to free', () => {
    expect(freeNasalAt(['a', 'la', 'gba'], 1)).toBeNull();
    expect(freeNasalAt(['gba'], 0)).toBeNull();
  });

  it('returns null for a syllable that is only a nasal - it is already free', () => {
    expect(freeNasalAt(['a', 'n̄', 'gba'], 1)).toBeNull();
  });

  it('returns null for an out-of-range index rather than throwing', () => {
    expect(freeNasalAt(['a', 'lan'], 5)).toBeNull();
    expect(freeNasalAt([], 0)).toBeNull();
  });

  it('leaves an already-marked nasal alone', () => {
    // `ǹ` is already syllabic; there is nothing absorbed here.
    expect(freeNasalAt(['a', 'lá', 'ǹ', 'gbá'], 1)).toBeNull();
  });
});

describe('absorbNasalAt', () => {
  it('absorbs a lone nasal into the syllable before it, dropping its tone mark', () => {
    // A coda carries no tone of its own - the vowel does. So the mark goes, which makes the merge
    // a visible spelling change, which is honest: it is a claim about the word.
    expect(absorbNasalAt(['a', 'lá', 'ǹ', 'gbá'], 2)).toEqual(['a', 'lán', 'gbá']);
  });

  it('round-trips freeing and absorbing back to the original', () => {
    const original = ['a', 'lan', 'gba'];
    const freed = freeNasalAt(original, 1)!;
    expect(absorbNasalAt(freed, 2)).toEqual(original);
  });

  it('absorbs an m into a preceding syllable when a labial follows', () => {
    // In isolation `jàm` does not absorb - there is no labial after it. In context there is, which
    // is exactly why these functions take the whole array rather than one syllable.
    expect(absorbNasalAt(['jà', 'm̀', 'bá'], 1)).toEqual(['jàm', 'bá']);
  });

  it('refuses an m where no labial follows, because no coda m is licensed there', () => {
    expect(absorbNasalAt(['a', 'm', 'ta'], 1)).toBeNull();
    expect(absorbNasalAt(['a', 'm'], 1)).toBeNull();
  });

  it('refuses a nasal after a plain e or o, which cannot be nasalised', () => {
    // The rule lives in syllabify.ts; this is it withdrawing the offer automatically, via the
    // re-derivation check rather than a second copy of the rule.
    //
    // Marked nasals here (`n̄`, not `n`), because that is what a split actually contains: a lone
    // BARE nasal after a nasalisable vowel is not a state the splitter can produce - it would have
    // absorbed it - so the input guard turns those away as inconsistent.
    expect(absorbNasalAt(['ke', 'n̄'], 1)).toBeNull();
    expect(absorbNasalAt(['ko', 'n̄'], 1)).toBeNull();
    // The underdotted counterparts do nasalise, so those merge.
    expect(absorbNasalAt(['kẹ', 'n̄'], 1)).toEqual(['kẹn']);
    expect(absorbNasalAt(['kọ', 'n̄'], 1)).toEqual(['kọn']);
  });

  it('refuses a split that does not re-derive from its own text, rather than inventing a third one', () => {
    // `gan-an`: the splitter models no hyphen, so ['gan','an'] joins to `ganan`, which re-splits as
    // ['ga','nan']. EntryReview never offers this word at all (syllabifySpans returns null for
    // hyphenated forms), but a primitive that mangled it when called directly is a trap.
    expect(syllabifyWord('gan-an')).toEqual(['gan', 'an']);
    expect(absorbNasalAt(['gan', 'an'], 1)).toBeNull();
    expect(freeNasalAt(['gan', 'an'], 0)).toBeNull();
  });

  it('returns null at index 0, where there is nothing to absorb into', () => {
    expect(absorbNasalAt(['n̄', 'kan'], 0)).toBeNull();
  });

  it('returns null when the syllable is not a lone nasal', () => {
    expect(absorbNasalAt(['a', 'lan', 'gba'], 1)).toBeNull();
    expect(absorbNasalAt(['a', 'gba'], 1)).toBeNull();
  });
});

describe('canFreeNasal / canAbsorbNasal agree with the operations they describe', () => {
  // The UI renders a control from these, so a predicate that said yes where the operation returns
  // null would offer a button that does nothing.
  const cases: string[][] = [
    ['a', 'lan', 'gba'],
    ['a', 'lá', 'ǹ', 'gbá'],
    ['jà', 'm̀', 'bá'],
    ['ke', 'n'],
    ['a', 'm', 'ta'],
    ['gba'],
  ];
  it.each(cases)('for %s', (...syllables) => {
    for (let i = 0; i < syllables.length; i += 1) {
      expect(canFreeNasal(syllables, i)).toBe(freeNasalAt(syllables, i) !== null);
      expect(canAbsorbNasal(syllables, i)).toBe(absorbNasalAt(syllables, i) !== null);
    }
  });
});

// ---------------------------------------------------------------------------
// The corpus-wide property
// ---------------------------------------------------------------------------
// Everything above is examples. This is the guarantee: over every real form, a flip in either
// direction produces a split that re-derives to itself. If it did not, the flipped boundary would
// be invisible on the next load - EntryReview re-derives from display_text - and would be
// silently overwritten, taking that word's recordings out of the game with it.

// The Kaikki lexicon fixture, not syllabify.json: the latter is the ~90-word student vocabulary,
// which contains too few nasals to make a property test mean anything. This is the whole ingested
// corpus, and it is where the ambiguity actually lives.
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const lexicon: Record<string, Array<{ canonicalForm: { value: string } }>> = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'raw_kaikki_lexicon.json'), 'utf8'),
);
const forms = [
  ...new Set(
    Object.values(lexicon)
      .flat()
      .map((e) => e.canonicalForm?.value)
      .filter((v): v is string => typeof v === 'string' && v !== '' && !/\s/.test(v)),
  ),
];

describe('over the real corpus', () => {
  it('has forms to test against', () => {
    expect(forms.length).toBeGreaterThan(4000);
  });

  it('every freeable nasal, freed, produces a split that re-derives to itself', () => {
    let flips = 0;
    for (const form of forms) {
      const syllables = syllabifyWord(form);
      for (let i = 0; i < syllables.length; i += 1) {
        const freed = freeNasalAt(syllables, i);
        if (freed === null) continue;
        flips += 1;
        expect(syllabifyWord(freed.join('')), `freeing ${form} at ${i}`).toEqual(freed);
      }
    }
    // Asserted so the test cannot pass by finding nothing to flip.
    expect(flips).toBeGreaterThan(800);
  });

  it('every absorbable nasal, absorbed, produces a split that re-derives to itself', () => {
    let flips = 0;
    for (const form of forms) {
      const syllables = syllabifyWord(form);
      for (let i = 0; i < syllables.length; i += 1) {
        const absorbed = absorbNasalAt(syllables, i);
        if (absorbed === null) continue;
        flips += 1;
        expect(syllabifyWord(absorbed.join('')), `absorbing ${form} at ${i}`).toEqual(absorbed);
      }
    }
    expect(flips).toBeGreaterThan(100);
  });

  it('freeing then absorbing returns the original split, for every freeable nasal', () => {
    for (const form of forms) {
      const syllables = syllabifyWord(form);
      for (let i = 0; i < syllables.length; i += 1) {
        const freed = freeNasalAt(syllables, i);
        if (freed === null) continue;
        expect(absorbNasalAt(freed, i + 1), `round trip on ${form} at ${i}`).toEqual(syllables);
      }
    }
  });
});

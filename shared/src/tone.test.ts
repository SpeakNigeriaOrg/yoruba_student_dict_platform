import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTone, applyTones, lettersOf, toneBearerKind, toneOf, tonesOf } from './tone';
import { syllabifySpans, syllabifyWord } from './syllabify';
import type { KaikkiLexicon } from './types';

const MACRON = String.fromCharCode(0x0304);

describe('toneBearerKind', () => {
  it('puts the tone on the vowel when a syllable has both a vowel and a nasal', () => {
    // `gban` is gb + a + coda n. The n is not the nucleus.
    expect(toneBearerKind('gban')).toBe('vowel');
    expect(toneBearerKind('mọ')).toBe('vowel');
  });

  it('recognises a bare syllabic nasal as the bearer', () => {
    expect(toneBearerKind('n')).toBe('nasal');
    expect(toneBearerKind('ń')).toBe('nasal');
    expect(toneBearerKind('m̄')).toBe('nasal');
  });

  it('sees through the underdot of ẹ/ọ, which NFD splits off', () => {
    expect(toneBearerKind('yẹ')).toBe('vowel');
    expect(toneBearerKind('kọ́')).toBe('vowel');
  });

  it('reports nothing for a consonant-only syllable - Wiktionary has bare letter entries', () => {
    expect(toneBearerKind('gb')).toBeNull();
    expect(toneBearerKind('b')).toBeNull();
    expect(toneBearerKind('ṣ')).toBeNull();
  });
});

describe('toneOf', () => {
  it('reads the three marks', () => {
    expect(toneOf('dì')).toBe('low');
    expect(toneOf('lá')).toBe('high');
    expect(toneOf('n̄')).toBe('mid');
  });

  it('reads an unmarked VOWEL as mid - that is the standard orthography', () => {
    expect(toneOf('a')).toBe('mid');
    expect(toneOf('gba')).toBe('mid');
  });

  it('refuses to read an unmarked syllabic NASAL as mid', () => {
    // On a nasal, mid is written with a macron. An unmarked one is under-marked
    // upstream (9 in the corpus); reporting "mid" would turn a gap in the data into
    // a positive claim, and would also silently add a macron on the round trip.
    expect(toneOf('n')).toBeNull();
    expect(toneOf('m')).toBeNull();
  });

  it('reports nothing when nothing can carry tone', () => {
    expect(toneOf('gb')).toBeNull();
  });
});

describe('applyTone: mid depends on what carries it', () => {
  it('writes mid on a vowel as no mark at all', () => {
    expect(applyTone('gbá', 'mid')).toBe('gba');
    expect(applyTone('dì', 'mid')).toBe('di');
  });

  it('writes mid on a syllabic nasal as a macron', () => {
    // Not cosmetic: the macron is what distinguishes syllabic n̄ from coda n.
    expect(applyTone('n', 'mid')).toBe(`n${MACRON}`.normalize('NFC'));
    expect(applyTone('ń', 'mid')).toBe(`n${MACRON}`.normalize('NFC'));
  });

  it('replaces an existing mark rather than stacking a second one', () => {
    const high = applyTone('dì', 'high');
    expect(high).toBe('dí');
    expect([...high.normalize('NFD')].filter((c) => c === String.fromCharCode(0x0300))).toHaveLength(0);
  });

  it('keeps the underdot, which is a letter and not a tone', () => {
    expect(applyTone('yẹ', 'low')).toBe('yẹ̀');
    expect(applyTone('kọ́', 'low')).toBe('kọ̀');
    expect(applyTone('ṣẹ', 'high')).toBe('ṣẹ́');
  });

  it('composes an underdot and a tone mark in canonical order', () => {
    const out = applyTone('yẹ', 'high');
    expect(out).toBe(out.normalize('NFC'));
    expect(out.normalize('NFC')).toBe('yẹ́'.normalize('NFC'));
  });

  it('puts the mark on the vowel, not the coda nasal', () => {
    expect(applyTone('gban', 'high')).toBe('gbán');
    expect(applyTone('gban', 'low')).toBe('gbàn');
  });

  it('leaves a syllable with no bearer completely untouched', () => {
    for (const tone of ['low', 'mid', 'high'] as const) {
      expect(applyTone('gb', tone)).toBe('gb');
      expect(applyTone('b', tone)).toBe('b');
    }
  });
});

describe('lettersOf', () => {
  it('strips tone and keeps underdots', () => {
    expect(lettersOf('kọ́')).toBe('kọ');
    expect(lettersOf('yẹ̀')).toBe('yẹ');
    expect(lettersOf('dì')).toBe('di');
  });

  it('strips the macron off a syllabic nasal too', () => {
    expect(lettersOf('n̄')).toBe('n');
    expect(lettersOf('ǹ')).toBe('n');
  });
});

describe('the real syllabic-nasal words', () => {
  // These are the cases that forced mid-on-nasal to be a macron, and the reason
  // "letters" cannot be a tone-stripped string.
  const cases: Array<[string, string[]]> = [
    ['gban̄gba', ['gba', 'n̄', 'gba']],
    ['Faran̄sé', ['Fa', 'ra', 'n̄', 'sé']],
    ['n̄kọ́', ['n̄', 'kọ́']],
    ['aláǹgbá', ['a', 'lá', 'ǹ', 'gbá']],
    ['olóńgbò', ['o', 'ló', 'ń', 'gbò']],
  ];

  for (const [word, expected] of cases) {
    it(`${word} splits with the nasal as its own syllable, and round-trips`, () => {
      const syllables = syllabifySpans(word);
      expect(syllables).toEqual(expected);
      expect(applyTones(syllables!, tonesOf(syllables!)).join('')).toBe(word.normalize('NFC'));
    });
  }

  it('stripping tone would destroy the syllable boundary - which is why we never do it', () => {
    // Documents the hazard the per-syllable editor exists to avoid.
    expect(syllabifyWord('gban̄gba')).toHaveLength(3);
    expect(syllabifyWord('gbangba')).toHaveLength(2);
  });
});

describe('syllabifySpans preserves capitalization', () => {
  it('keeps a proper noun capitalised, unlike syllabifyWord', () => {
    expect(syllabifyWord('Agẹmọ')).toEqual(['a', 'gẹ', 'mọ']);
    expect(syllabifySpans('Agẹmọ')).toEqual(['A', 'gẹ', 'mọ']);
  });

  it('rejoins to exactly the original', () => {
    for (const word of ['Agẹmọ', 'Beélú', 'Ọ̀wàwà', 'adìyẹ', 'Ṣẹẹrẹ', 'olóńgbò']) {
      expect(syllabifySpans(word)!.join('')).toBe(word.normalize('NFC'));
    }
  });

  it('agrees with syllabifyWord on where the boundaries are', () => {
    for (const word of ['Agẹmọ', 'Faran̄sé', 'aláǹgbá']) {
      expect(syllabifySpans(word)!.map((s) => s.toLowerCase())).toEqual(syllabifyWord(word));
    }
  });

  it('refuses text it cannot reproduce, rather than returning a lossy split', () => {
    // All real lexicon entries. syllabifyWord drops what it does not model, so a
    // tone editor built on it would rewrite these the moment anyone touched them.
    expect(syllabifySpans('gan-an')).toBeNull(); // hyphen dropped -> 'ganan'
    expect(syllabifySpans('hà!')).toBeNull(); // '!' dropped
    expect(syllabifySpans('دعِ')).toBeNull(); // Ajami (Arabic-script Yoruba)
  });
});

// ---------------------------------------------------------------------------
// The property, over every real form in the corpus
// ---------------------------------------------------------------------------
// A tone editor is only a faithful representation of a word if reading its tone and
// writing it back is the identity. Asserted over the whole ingested lexicon rather
// than a handful of examples, because the failure mode is silent corruption of a
// word nobody looked at.

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const lexicon: KaikkiLexicon = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'raw_kaikki_lexicon.json'), 'utf8'));

describe('tone round trip over the real corpus fixture', () => {
  const forms = [...new Set(Object.values(lexicon).flat().map((s) => s.canonicalForm.value))].filter(
    (f) => f && !f.includes(' '),
  );

  it('has real forms to test against', () => {
    expect(forms.length).toBeGreaterThan(50);
  });

  /** The forms a tone editor can actually represent. The rest are refused outright
   * (Ajami, hyphens, interjections) and never reach the editor. */
  const editable = forms.filter((f) => syllabifySpans(f) !== null);

  it('can represent the great majority of real forms, and refuses the rest cleanly', () => {
    expect(editable.length / forms.length).toBeGreaterThan(0.9);
    // The refused ones are reported rather than hidden, so a silent collapse in
    // coverage would fail this test rather than pass unnoticed.
    const refused = forms.filter((f) => syllabifySpans(f) === null);
    expect(refused.length + editable.length).toBe(forms.length);
  });

  it('reading and rewriting the tone of every syllable is the identity', () => {
    const broken: string[] = [];
    let syllablesChecked = 0;

    for (const form of editable) {
      const syllables = syllabifySpans(form)!;
      syllablesChecked += syllables.length;
      const rebuilt = applyTones(syllables, tonesOf(syllables)).join('');
      if (rebuilt !== form.normalize('NFC')) broken.push(`${form} -> ${rebuilt}`);
    }

    expect(syllablesChecked).toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });

  it('never emits more than one tone mark on a syllable', () => {
    const TONES = new Set([String.fromCharCode(0x0300), String.fromCharCode(0x0301), MACRON]);
    const offenders: string[] = [];
    for (const form of editable) {
      for (const syllable of syllabifySpans(form)!) {
        for (const tone of ['low', 'mid', 'high'] as const) {
          const marks = [...applyTone(syllable, tone).normalize('NFD')].filter((c) => TONES.has(c));
          if (marks.length > 1) offenders.push(`${form}/${syllable}/${tone}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every editable syllable rejoins to the original word', () => {
    const broken = editable.filter((f) => syllabifySpans(f)!.join('') !== f.normalize('NFC'));
    expect(broken).toEqual([]);
  });

  it('leaves out-of-model marks alone instead of rewriting them', () => {
    // Circumflex and macron-on-a-vowel report no tone, so the editor never touches
    // them - which is what makes the identity above exact rather than approximate.
    for (const odd of ['ộ', 'ọ̄', 'ẹ̄']) {
      expect(toneOf(odd)).toBeNull();
      expect(applyTones([odd], tonesOf([odd])).join('')).toBe(odd.normalize('NFC'));
    }
  });
});

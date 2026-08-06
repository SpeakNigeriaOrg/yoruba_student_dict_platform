import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseEntry } from './diagnoseEntry';
import { checkSyllableSplit, resolveEffectiveDisplayText, type CheckSyllableSplitResult } from './syllableSplit';
import type { DiagnosticsOverrides, KaikkiLexicon, Vocab } from './types';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const vocab = loadFixture<Vocab>('raw_vocab.json');
const lexicon = loadFixture<KaikkiLexicon>('raw_kaikki_lexicon.json');
const overrides = loadFixture<DiagnosticsOverrides>('raw_overrides.json');

interface FullDiagnosticsReportEntry {
  wordId: string;
  [field: string]: unknown;
}

interface FullDiagnosticsReport {
  entries: FullDiagnosticsReportEntry[];
}

const report = loadFixture<FullDiagnosticsReport>('full_diagnostics_report.json');
const reportById = new Map(report.entries.map((e) => [e.wordId, e]));

const SYLLABLE_SPLIT_FIELDS = [
  'syllableSplitStatus',
  'syllableSplitManual',
  'syllableSplitProgrammatic',
  'syllableSplitNote',
] as const;

function pickSyllableSplitFields(entry: FullDiagnosticsReportEntry): Partial<CheckSyllableSplitResult> {
  const picked: Partial<CheckSyllableSplitResult> = {};
  for (const key of SYLLABLE_SPLIT_FIELDS) {
    if (key in entry) (picked as Record<string, unknown>)[key] = entry[key];
  }
  return picked;
}

// Mirrors generate_diagnostics()'s pipeline: diagnose_entry ->
// resolve_effective_display_text -> check_syllable_split.
function computeSyllableSplitFields(wordId: string): CheckSyllableSplitResult {
  const entry = vocab[wordId];
  const override = overrides[wordId];
  const diagnosis = diagnoseEntry(wordId, entry, lexicon, override);
  const { displayText, wasSubstituted } = resolveEffectiveDisplayText(entry, diagnosis, override);
  return checkSyllableSplit(displayText, entry.syllables, override, wasSubstituted);
}

/** The one word whose programmatic split deliberately differs from the Python engine's - see
 * DELIBERATE_DIVERGENCES in syllabify.test.ts for the rule and the reason. Its *status* is
 * unaffected: it was a mismatch before and it is a mismatch now, which is the report field that
 * actually drives the review UI. */
const DIVERGENT_PROGRAMMATIC_SPLIT: Record<string, string[]> = {
  agunfon_giraffe: ['à', 'gùn', 'fo', 'n'],
};

describe('checkSyllableSplit (parity with generate_diagnostics.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(Object.keys(vocab).length).toBeGreaterThan(0);
  });

  for (const wordId of Object.keys(vocab)) {
    it(`${wordId}: matches the Python engine's syllable-split output`, () => {
      const expectedFull = reportById.get(wordId);
      expect(expectedFull, `no report entry found for ${wordId}`).toBeDefined();
      const actual = computeSyllableSplitFields(wordId);
      const expected = pickSyllableSplitFields(expectedFull!);
      const divergent = DIVERGENT_PROGRAMMATIC_SPLIT[wordId];
      if (divergent) {
        // Assert the divergence explicitly rather than loosening the comparison: the Python value
        // must still be what the report says, and ours must be the documented replacement.
        expect(expected.syllableSplitProgrammatic).toEqual(['à', 'gùn', 'fon']);
        expect(actual.syllableSplitProgrammatic).toEqual(divergent);
        expect(actual.syllableSplitStatus).toBe(expected.syllableSplitStatus);
        expect({ ...actual, syllableSplitProgrammatic: undefined }).toEqual({
          ...expected,
          syllableSplitProgrammatic: undefined,
        });
        return;
      }
      expect(actual).toEqual(expected);
    });
  }
});

describe('checkSyllableSplit direct unit tests', () => {
  // No word in the real dictionary_overrides.json currently sets
  // syllableAction, so both resolution branches and the
  // moot-override/checked-against-pending-adoption notes are synthetic -
  // tested directly rather than left unverified.

  it('reports a mismatch as resolved_keep_manual when syllableAction is keep_manual', () => {
    const result = checkSyllableSplit('àgùnfon', ['à', 'gùn', 'fọn'], { syllableAction: 'keep_manual' });
    expect(result.syllableSplitStatus).toBe('resolved_keep_manual');
    expect(result.syllableSplitManual).toEqual(['à', 'gùn', 'fọn']);
    // Four, not three: plain `o` cannot carry a nasal coda, so the `n` of `fon` is its own
    // syllable. Still a mismatch against the manual split either way - which is the point of the
    // test, and why this word makes a good fixture for it.
    expect(result.syllableSplitProgrammatic).toEqual(['à', 'gùn', 'fo', 'n']);
  });

  it('reports a mismatch as resolved_accept_programmatic when syllableAction is accept_programmatic', () => {
    const result = checkSyllableSplit('àgùnfon', ['à', 'gùn', 'fọn'], { syllableAction: 'accept_programmatic' });
    expect(result.syllableSplitStatus).toBe('resolved_accept_programmatic');
  });

  it('includes syllableNote when set on a real mismatch', () => {
    const result = checkSyllableSplit('àgùnfon', ['à', 'gùn', 'fọn'], {
      syllableAction: 'keep_manual',
      syllableNote: 'the underdot is intentional',
    });
    expect(result.syllableSplitNote).toBe('the underdot is intentional');
  });

  it('flags a syllableAction as moot once the splits actually agree', () => {
    const result = checkSyllableSplit('ejika', ['e', 'ji', 'ka'], { syllableAction: 'keep_manual' });
    expect(result.syllableSplitStatus).toBe('match');
    expect(result.syllableSplitNote).toContain('is now moot');
  });

  it('notes when checked against a pending adopted spelling rather than the current displayText', () => {
    const result = checkSyllableSplit('ejika', ['e', 'ji', 'ka'], null, true);
    expect(result.syllableSplitNote).toContain('pending adopted spelling');
  });
});

describe('resolveEffectiveDisplayText', () => {
  it('substitutes the adoption target when adopt_kaikki is decided and differs from the current spelling', () => {
    const result = resolveEffectiveDisplayText(
      { displayText: 'kasu', syllables: ['ka', 'su'] },
      { wordId: 'w', displayText: 'kasu', status: 'tone_mismatch', adoptionTarget: 'kásù' },
      { action: 'adopt_kaikki' },
    );
    expect(result).toEqual({ displayText: 'kásù', wasSubstituted: true });
  });

  it('leaves displayText untouched when no adopt_kaikki override is set', () => {
    const result = resolveEffectiveDisplayText(
      { displayText: 'kasu', syllables: ['ka', 'su'] },
      { wordId: 'w', displayText: 'kasu', status: 'tone_mismatch', adoptionTarget: 'kásù' },
      null,
    );
    expect(result).toEqual({ displayText: 'kasu', wasSubstituted: false });
  });
});

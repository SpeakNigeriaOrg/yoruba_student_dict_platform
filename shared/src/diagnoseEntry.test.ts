import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOverride, diagnoseEntry, type DiagnoseEntryResult } from './diagnoseEntry';
import type { DiagnosticsOverrides, KaikkiLexicon, Vocab } from './types';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const vocab = loadFixture<Vocab>('raw_vocab.json');
const lexicon = loadFixture<KaikkiLexicon>('raw_kaikki_lexicon.json');
const overrides = loadFixture<DiagnosticsOverrides>('raw_overrides.json');

interface FullDiagnosticsReportEntry extends DiagnoseEntryResult {
  [otherAxisField: string]: unknown;
}

interface FullDiagnosticsReport {
  summary: Record<string, number>;
  totalEntries: number;
  entries: FullDiagnosticsReportEntry[];
}

const report = loadFixture<FullDiagnosticsReport>('full_diagnostics_report.json');
const reportById = new Map(report.entries.map((e) => [e.wordId, e]));

interface DiagnoseEntryRegression {
  name: string;
  note: string;
  entry: FullDiagnosticsReportEntry;
}

const regressions = loadFixture<DiagnoseEntryRegression[]>('diagnose_entry_regressions.json');

// diagnose_entry only ever sets this subset of fields - the rest of a full
// report entry (syllableSplitStatus, definitionStatus, componentsProposal,
// etc.) comes from check_syllable_split/check_definition/
// components_axis_fields, none of which are ported yet. Comparing only
// these keeps this test honest about what it's actually verifying.
const DIAGNOSE_ENTRY_FIELDS = [
  'wordId',
  'displayText',
  'status',
  'englishHint',
  'matchedForm',
  'canonicalForm',
  'adoptionTarget',
  'matchedPos',
  'matchedGlosses',
  'matchedAltOfTargets',
  'matchedComponentCandidates',
  'resolvedBy',
  'candidatesConsidered',
  'discoveredViaRelaxedMatch',
  'note',
] as const;

function pickDiagnoseFields(entry: FullDiagnosticsReportEntry): Partial<DiagnoseEntryResult> {
  const picked: Partial<DiagnoseEntryResult> = {};
  for (const key of DIAGNOSE_ENTRY_FIELDS) {
    if (key in entry) (picked as Record<string, unknown>)[key] = entry[key];
  }
  return picked;
}

describe('diagnoseEntry (parity with generate_diagnostics.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(Object.keys(vocab).length).toBeGreaterThan(0);
    expect(report.entries.length).toBe(Object.keys(vocab).length);
  });

  for (const [wordId, entry] of Object.entries(vocab)) {
    it(`${wordId}: matches the Python engine's diagnose_entry output`, () => {
      const expectedFull = reportById.get(wordId);
      expect(expectedFull, `no report entry found for ${wordId}`).toBeDefined();
      const actual = diagnoseEntry(wordId, entry, lexicon, overrides[wordId]);
      expect(actual).toEqual(pickDiagnoseFields(expectedFull!));
    });
  }

  // Spelled out explicitly (already covered by the loop above) so these
  // previously-fixed bugs don't get lost in a generic parametrized loop -
  // see REMOTE_ACCESS_DISCUSSION.md §4.
  for (const regression of regressions) {
    it(`regression: ${regression.name}`, () => {
      const wordId = regression.entry.wordId;
      const actual = diagnoseEntry(wordId, vocab[wordId], lexicon, overrides[wordId]);
      expect(actual).toEqual(pickDiagnoseFields(regression.entry));
    });
  }
});

describe('applyOverride', () => {
  // No word in the real dictionary_overrides.json currently uses keep_ours
  // or adopt_kaikki (both branches below), so these are synthetic - they
  // test well-understood, currently-unexercised behavior directly rather
  // than leaving it unverified until real data happens to trigger it.

  it('keep_ours overrides the status regardless of the underlying match', () => {
    const result = applyOverride({ wordId: 'w', displayText: 'x', status: 'underdot_mismatch' }, { action: 'keep_ours' });
    expect(result.status).toBe('verified_keep_ours');
    expect(result.resolvedBy).toBe('keep_ours');
  });

  it('adopt_kaikki marks a real mismatch as decided_adopt_kaikki', () => {
    const result = applyOverride({ wordId: 'w', displayText: 'x', status: 'tone_mismatch' }, { action: 'adopt_kaikki' });
    expect(result.status).toBe('decided_adopt_kaikki');
    expect(result.resolvedBy).toBe('adopt_kaikki_pending');
  });

  it('adopt_kaikki on an already-matching entry leaves status as match, notes it as stale', () => {
    const result = applyOverride({ wordId: 'w', displayText: 'x', status: 'match' }, { action: 'adopt_kaikki' });
    expect(result.status).toBe('match');
    expect(result.resolvedBy).toBeUndefined();
    expect(result.note).toContain('adopt_kaikki override is now stale');
  });

  it('flags a candidateForm that never resolved to anything, even with no action', () => {
    const result = applyOverride({ wordId: 'w', displayText: 'x', status: 'not_in_kaikki' }, { candidateForm: 'nonexistent' });
    expect(result.note).toContain('override candidateForm not found among candidates');
  });
});

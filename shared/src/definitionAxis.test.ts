import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDefinition, resolveDefinitionSource, type CheckDefinitionResult } from './definitionAxis';
import { diagnoseEntry } from './diagnoseEntry';
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

interface DiagnoseEntryRegression {
  name: string;
  entry: FullDiagnosticsReportEntry;
}

const regressions = loadFixture<DiagnoseEntryRegression[]>('diagnose_entry_regressions.json');

// The exact set of fields check_definition sets on a report entry - see
// generate_diagnostics.py's check_definition. Compared in isolation from
// the spelling/etymology axes' own fields, same principle as
// diagnoseEntry.test.ts.
const DEFINITION_FIELDS = [
  'definitionCandidateGlosses',
  'definitionSourceForm',
  'definitionSourceIsCrossReference',
  'definitionLinkedSameAsSpelling',
  'definitionStatus',
  'definitionCurrent',
  'definitionProposed',
  'definitionNote',
] as const;

function pickDefinitionFields(entry: FullDiagnosticsReportEntry): Partial<CheckDefinitionResult> {
  const picked: Partial<CheckDefinitionResult> = {};
  for (const key of DEFINITION_FIELDS) {
    if (key in entry) (picked as Record<string, unknown>)[key] = entry[key];
  }
  return picked;
}

// Mirrors generate_diagnostics()'s per-entry pipeline (diagnose_entry ->
// resolve_definition_source -> check_definition) up through the definition
// axis - see that function's real source for the exact call shape.
function computeDefinitionFields(wordId: string): CheckDefinitionResult {
  const entry = vocab[wordId];
  const override = overrides[wordId];
  const diagnosis = diagnoseEntry(wordId, entry, lexicon, override);
  const source = resolveDefinitionSource(
    diagnosis.matchedForm,
    diagnosis.matchedGlosses,
    diagnosis.matchedAltOfTargets,
    lexicon,
    override,
  );
  return checkDefinition(
    entry,
    diagnosis.englishHint ?? '',
    source.glosses,
    override,
    source.sourceForm,
    source.isCrossReference,
    source.sourceForm === (diagnosis.matchedForm ?? null),
    source.note,
  );
}

describe('checkDefinition / resolveDefinitionSource (parity with generate_diagnostics.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(Object.keys(vocab).length).toBeGreaterThan(0);
  });

  for (const wordId of Object.keys(vocab)) {
    it(`${wordId}: matches the Python engine's definition-axis output`, () => {
      const expectedFull = reportById.get(wordId);
      expect(expectedFull, `no report entry found for ${wordId}`).toBeDefined();
      const actual = computeDefinitionFields(wordId);
      expect(actual).toEqual(pickDefinitionFields(expectedFull!));
    });
  }

  for (const regression of regressions) {
    it(`regression: ${regression.name}`, () => {
      const wordId = regression.entry.wordId;
      const actual = computeDefinitionFields(wordId);
      expect(actual).toEqual(pickDefinitionFields(regression.entry));
    });
  }
});

describe('resolveDefinitionSource', () => {
  // No word in the real dictionary_overrides.json currently sets
  // definitionSourceForm, so the explicit-override branch (both the
  // resolves-to-a-real-record and the typo/not-found cases) is
  // synthetic - tested directly rather than left unverified.

  it('follows an explicit definitionSourceForm override to a real record, dropping cross-reference-only glosses', () => {
    const lex: KaikkiLexicon = {
      x: [
        {
          pos: 'noun',
          etymologyNumber: null,
          headword: 'x',
          canonicalForm: { value: 'x', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'x' },
          standardForms: ['x'],
          glosses: ['a real sense', 'alternative form of y'],
          altOfTargets: [],
          componentCandidates: [],
          derivedForms: [],
        },
      ],
    };
    const result = resolveDefinitionSource('a', ['old'], [], lex, { definitionSourceForm: 'x' });
    expect(result).toEqual({ glosses: ['a real sense'], sourceForm: 'x', isCrossReference: false, note: null });
  });

  it('flags an explicit definitionSourceForm that does not resolve to anything', () => {
    const result = resolveDefinitionSource('a', ['old'], [], {}, { definitionSourceForm: 'nonexistent' });
    expect(result.note).toContain("definitionSourceForm 'nonexistent' not found in the lexicon");
    expect(result.glosses).toEqual(['old']);
  });

  it('redirects a single-target cross-reference to its real entry', () => {
    const lex: KaikkiLexicon = {
      y: [
        {
          pos: 'noun',
          etymologyNumber: null,
          headword: 'y',
          canonicalForm: { value: 'y', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'y' },
          standardForms: ['y'],
          glosses: ['the real meaning'],
          altOfTargets: [],
          componentCandidates: [],
          derivedForms: [],
        },
      ],
    };
    const result = resolveDefinitionSource('x', ['alternative form of y'], ['y'], lex);
    expect(result.glosses).toEqual(['the real meaning']);
    expect(result.sourceForm).toBe('y');
    expect(result.isCrossReference).toBe(false);
    expect(result.note).toContain('redirected from a Kaikki cross-reference');
  });

  it('leaves a multi-target cross-reference unresolved with a note', () => {
    const result = resolveDefinitionSource('x', ['alternative form of y'], ['y', 'z'], {});
    expect(result.isCrossReference).toBe(true);
    expect(result.note).toContain('multiple possible targets');
  });
});

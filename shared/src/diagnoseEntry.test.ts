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
  // matchedUsedInCandidates/matchedEtymologyText both postdate this
  // fixture entirely (the Python original never computed either, and the
  // real fixtures have neither usedInCandidates nor etymologyText data on
  // any KaikkiSense) - always [] / null whenever a "chosen" sense branch
  // would have set matchedComponentCandidates too, since all three are
  // set together in the same diagnoseEntry.ts branch.
  if ('matchedComponentCandidates' in picked) {
    picked.matchedUsedInCandidates = [];
    picked.matchedEtymologyText = null;
  }
  return picked;
}

/** matchedEntryId/matchedEtymologyNumber and the same two on each candidate carry
 * the upstream CITATION, which the Python engine had no concept of - a spelling
 * was the only identity it knew. So they are outside this fixture's parity
 * contract and are dropped before comparing, rather than being patched into the
 * expectation like the two fields above (whose values are constant; these
 * two vary per matched etymology, so a patch would just restate the code).
 *
 * Their behaviour is covered by the 'cites the matched etymology' block below. */
function withoutCitationFields(result: DiagnoseEntryResult): DiagnoseEntryResult {
  const { matchedEntryId: _id, matchedEtymologyNumber: _num, ...rest } = result;
  if (!rest.candidatesConsidered) return rest;
  return {
    ...rest,
    candidatesConsidered: rest.candidatesConsidered.map(({ entryId: _e, etymologyNumber: _n, ...c }) => c),
  };
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
      expect(withoutCitationFields(actual)).toEqual(pickDiagnoseFields(expectedFull!));
    });
  }

  // Spelled out explicitly (already covered by the loop above) so these
  // previously-fixed bugs don't get lost in a generic parametrized loop -
  // see REMOTE_ACCESS_DISCUSSION.md §4.
  for (const regression of regressions) {
    it(`regression: ${regression.name}`, () => {
      const wordId = regression.entry.wordId;
      const actual = diagnoseEntry(wordId, vocab[wordId], lexicon, overrides[wordId]);
      expect(withoutCitationFields(actual)).toEqual(pickDiagnoseFields(regression.entry));
    });
  }
});

describe('diagnoseEntry cites the matched etymology', () => {
  /** The three real `kọ́` etymologies: one spelling, three unrelated words. This
   * is why a citation cannot be a form string. */
  function koSense(entryId: string, etymologyNumber: string, pos: string, glosses: string[]): KaikkiLexicon[string][number] {
    return {
      entryId,
      etymologyNumber,
      pos,
      headword: 'kọ́',
      canonicalForm: { value: 'kọ́', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'kọ́' },
      standardForms: ['kọ́'],
      glosses,
      altOfTargets: [],
      componentCandidates: [],
      derivedForms: [],
    };
  }

  const koLexicon: KaikkiLexicon = {
    ko: [
      koSense('en-ko-yo-verb-BUILD', '2', 'verb', ['to build, construct', 'to learn, teach']),
      koSense('en-ko-yo-particle-NEG', '3', 'particle', ['a negation particle']),
      koSense('en-ko-yo-verb-HANG', '4', 'verb', ['to hang, suspend']),
    ],
  };
  const koEntry = { displayText: 'kọ́', syllables: ['kọ́'] };

  it('names the etymology it chose, so a citation records what was actually matched', () => {
    const single: KaikkiLexicon = { ko: [koSense('en-ko-yo-verb-HANG', '4', 'verb', ['to hang, suspend'])] };
    const result = diagnoseEntry('ko_hang', koEntry, single);
    expect(result.matchedEntryId).toBe('en-ko-yo-verb-HANG');
    expect(result.matchedEtymologyNumber).toBe('4');
  });

  it('gives every ambiguous candidate its own id, so a human pick is storable as the etymology they picked', () => {
    const result = diagnoseEntry('ko_something', koEntry, koLexicon);
    expect(result.status).toBe('ambiguous_match');
    expect(result.candidatesConsidered?.map((c) => [c.entryId, c.etymologyNumber])).toEqual([
      ['en-ko-yo-verb-BUILD', '2'],
      ['en-ko-yo-particle-NEG', '3'],
      ['en-ko-yo-verb-HANG', '4'],
    ]);
    // All three carry the identical form, which is exactly why storing the form
    // alone loses the human's choice.
    expect(new Set(result.candidatesConsidered?.map((c) => c.form))).toEqual(new Set(['kọ́']));
  });

  it('does not claim a citation when no single etymology was chosen', () => {
    const ambiguous = diagnoseEntry('ko_something', koEntry, koLexicon);
    expect(ambiguous.matchedEntryId).toBeUndefined();

    const absent = diagnoseEntry('zzz_nothing', { displayText: 'zzzzz', syllables: ['zzzzz'] }, koLexicon);
    expect(absent.status).toBe('not_in_kaikki');
    expect(absent.matchedEntryId).toBeUndefined();
  });

  it('reports null rather than a fake id for a corpus ingested before 0014', () => {
    const idless: KaikkiLexicon = {
      ko: [{ ...koSense('x', '4', 'verb', ['to hang, suspend']), entryId: null }],
    };
    expect(diagnoseEntry('ko_hang', koEntry, idless).matchedEntryId).toBeNull();
  });

  it("still resolves a stored candidateForm the lossy way for pre-citation decisions - taking the FIRST match", () => {
    // Documents the defect the citation exists to fix, rather than pretending it
    // was never there: an override that only recorded 'kọ́' cannot express which
    // of the three was meant, so it lands on etymology 2 whatever was chosen.
    const result = diagnoseEntry('ko_hang', koEntry, koLexicon, { candidateForm: 'kọ́' });
    expect(result.matchedEntryId).toBe('en-ko-yo-verb-BUILD');
  });
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

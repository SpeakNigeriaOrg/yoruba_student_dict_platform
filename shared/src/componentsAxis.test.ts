import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildComponentOwnersIndex,
  buildVocabSpellingIndex,
  componentsAxisFields,
  previewGlossesForForm,
  type ComponentsAxisFieldsResult,
} from './componentsAxis';
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

const index = buildVocabSpellingIndex(vocab);
const componentOwners = buildComponentOwnersIndex(vocab);

const COMPONENTS_FIELDS = ['componentsProposal', 'usedAsComponentOf', 'components', 'invalidComponents'] as const;

function pickComponentsFields(entry: FullDiagnosticsReportEntry): Partial<ComponentsAxisFieldsResult> {
  const picked: Partial<ComponentsAxisFieldsResult> = {};
  for (const key of COMPONENTS_FIELDS) {
    if (key in entry) (picked as Record<string, unknown>)[key] = entry[key];
  }
  return picked;
}

// Mirrors generate_diagnostics()'s second pass: diagnose_entry (for
// matchedComponentCandidates) -> components_axis_fields, using the shared
// vocab-wide indexes exactly like the real report generation does.
function computeComponentsFields(wordId: string): ComponentsAxisFieldsResult {
  const entry = vocab[wordId];
  const diagnosis = diagnoseEntry(wordId, entry, lexicon, overrides[wordId]);
  return componentsAxisFields(
    wordId,
    vocab,
    diagnosis.matchedComponentCandidates,
    lexicon,
    overrides,
    index,
    componentOwners,
  );
}

describe('componentsAxisFields (parity with generate_diagnostics.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(Object.keys(vocab).length).toBeGreaterThan(0);
  });

  for (const wordId of Object.keys(vocab)) {
    it(`${wordId}: matches the Python engine's etymology-axis output`, () => {
      const expectedFull = reportById.get(wordId);
      expect(expectedFull, `no report entry found for ${wordId}`).toBeDefined();
      const actual = computeComponentsFields(wordId);
      expect(actual).toEqual(pickComponentsFields(expectedFull!));
    });
  }
});

// None of the real vocab's componentsProposal items currently resolve to a
// confident exact wordId match, are ambiguous, or surface a
// tone-insensitive possibleMatches hint - every real case falls through to
// the "no confident match, here's a gloss preview" branch. These branches
// (and invalidComponents, never present in well-formed real data) are
// covered directly instead of left unverified.
describe('componentsAxisFields direct unit tests', () => {
  const smallVocab: Vocab = {
    owo_hand: { displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'] },
    owo_hand_dup: { displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'] },
    okan_heart: { displayText: 'ọkàn', syllables: ['ọ', 'kàn'] },
    ile_kunle_phrase: { displayText: 'ilé kunlẹ̀', syllables: ['i', 'lé'], type: 'phrase', components: ['owo_hand'] },
    dangling_ref: { displayText: 'dangling', syllables: ['dang', 'ling'], components: ['nonexistent_word'] },
  };
  const smallIndex = buildVocabSpellingIndex(smallVocab);
  const smallOwners = buildComponentOwnersIndex(smallVocab);

  it('leaves an exact match unresolved (wordId: null) when more than one vocab entry shares the spelling', () => {
    const result = componentsAxisFields(
      'okan_heart',
      smallVocab,
      [{ form: 'ọwọ́', provenance: 'etymology_template' }],
      {},
      {},
      smallIndex,
      smallOwners,
    );
    expect(result.componentsProposal[0]).toMatchObject({
      wordId: null, // exact-spelling key collides between owo_hand/owo_hand_dup
      ambiguous: true,
      possibleMatches: [], // an exact-spelling hit (even an ambiguous one) skips the tone-insensitive fallback
    });
  });

  it('resolves a confident exact match when only one vocab entry shares the spelling, and keeps the gloss preview when unconfirmed', () => {
    const uniqueVocab: Vocab = {
      owo_hand: { displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'] },
      okan_heart: { displayText: 'ọkàn', syllables: ['ọ', 'kàn'] },
    };
    const uniqueIndex = buildVocabSpellingIndex(uniqueVocab);
    const uniqueOwners = buildComponentOwnersIndex(uniqueVocab);
    const result = componentsAxisFields(
      'okan_heart',
      uniqueVocab,
      [{ form: 'ọwọ́', provenance: 'etymology_template' }],
      {},
      {},
      uniqueIndex,
      uniqueOwners,
    );
    expect(result.componentsProposal[0].wordId).toBe('owo_hand');
    expect(result.componentsProposal[0].targetSpellingConfirmed).toBe(false);
    expect(result.componentsProposal[0].ambiguous).toBe(false);
  });

  it('suppresses the gloss preview once the matched target word has a confirmed spelling decision', () => {
    const uniqueVocab: Vocab = {
      owo_hand: { displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'] },
      okan_heart: { displayText: 'ọkàn', syllables: ['ọ', 'kàn'] },
    };
    const uniqueIndex = buildVocabSpellingIndex(uniqueVocab);
    const uniqueOwners = buildComponentOwnersIndex(uniqueVocab);
    const result = componentsAxisFields(
      'okan_heart',
      uniqueVocab,
      [{ form: 'ọwọ́', provenance: 'etymology_template' }],
      {},
      { owo_hand: { action: 'keep_ours' } },
      uniqueIndex,
      uniqueOwners,
    );
    expect(result.componentsProposal[0]).toMatchObject({
      wordId: 'owo_hand',
      targetSpellingConfirmed: true,
      previewGlosses: [],
      previewGlossesAreExactMatches: false,
    });
  });

  it('surfaces a tone-insensitive-only coincidence as possibleMatches, never auto-resolved', () => {
    const toneVocab: Vocab = { okan_heart: { displayText: 'ọkàn', syllables: ['ọ', 'kàn'] } };
    const toneIndex = buildVocabSpellingIndex(toneVocab);
    const toneOwners = buildComponentOwnersIndex(toneVocab);
    // "ọkán" differs only by tone from "ọkàn" - no exact match, but a
    // tone-insensitive one.
    const result = componentsAxisFields(
      'other_word',
      { ...toneVocab, other_word: { displayText: 'x', syllables: ['x'] } },
      [{ form: 'ọkán', provenance: 'etymology_template' }],
      {},
      {},
      toneIndex,
      toneOwners,
    );
    expect(result.componentsProposal[0].wordId).toBeNull();
    expect(result.componentsProposal[0].possibleMatches).toEqual(['okan_heart']);
  });

  it('reports invalidComponents for a dangling component reference', () => {
    const result = componentsAxisFields('dangling_ref', smallVocab, [], {}, {}, smallIndex, smallOwners);
    expect(result.invalidComponents).toEqual(['nonexistent_word']);
    expect(result.components).toEqual(['nonexistent_word']);
  });

  it('defaults an atomic word (no components field) to a self-referencing components list', () => {
    const result = componentsAxisFields('okan_heart', smallVocab, [], {}, {}, smallIndex, smallOwners);
    expect(result.components).toEqual(['okan_heart']);
    expect(result.invalidComponents).toBeUndefined();
  });

  it('builds the reverse usedAsComponentOf index from other entries’ own components lists', () => {
    const result = componentsAxisFields('owo_hand', smallVocab, [], {}, {}, smallIndex, smallOwners);
    expect(result.usedAsComponentOf).toEqual(['ile_kunle_phrase']);
  });
});

describe('previewGlossesForForm', () => {
  it('returns no glosses and isExactMatch=false when the spelling has no lexicon entry at all', () => {
    expect(previewGlossesForForm('nonexistent', {})).toEqual({ glosses: [], isExactMatch: false });
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveAltOfTargets,
  deriveComponentCandidateForms,
  deriveDerivedFormTexts,
  deriveGlosses,
  deriveIndexKeys,
  deriveSense,
  deriveSenses,
  deriveStandardForms,
  hasNonstandardSense,
} from './deriveSenses.js';
import type { CanonicalEntries, CanonicalEntry } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const realEntries: CanonicalEntries = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'entries.json'), 'utf8'));

function makeEntry(overrides: Partial<CanonicalEntry>): CanonicalEntry {
  return {
    id: 'test-id',
    headword: 'x',
    lang: 'Yoruba',
    langCode: 'yo',
    pos: 'noun',
    etymologyNumber: null,
    etymologyText: null,
    etymologyTemplates: [],
    etymologyMorphemes: [],
    usedInCompounds: [],
    canonicalForm: { value: 'x', inferenceMethod: 'fallback_headword', confidence: 0.5, originalValue: 'x' },
    altForms: [],
    ipa: [],
    senses: [],
    derivedTerms: [],
    relatedTerms: [],
    synonyms: [],
    antonyms: [],
    descendants: [],
    forms: { exact: 'x', toneInsensitive: 'x', orthographyInsensitive: 'x' },
    provenance: { source: 'kaikki', sourceLineIndex: 0 },
    ...overrides,
  };
}

describe('hasNonstandardSense', () => {
  it('is false when no sense has a nonstandard tag', () => {
    const entry = makeEntry({ senses: [{ id: 's1', glosses: [], rawGlosses: [], tags: ['uppercase'], examples: [], links: [], altOf: [] }] });
    expect(hasNonstandardSense(entry)).toBe(false);
  });

  it('is true when any sense has a dialect/archaic tag', () => {
    const entry = makeEntry({ senses: [{ id: 's1', glosses: [], rawGlosses: [], tags: ['Ekiti', 'alt-of'], examples: [], links: [], altOf: [] }] });
    expect(hasNonstandardSense(entry)).toBe(true);
  });

  it("real data: 'o' (alternative form of wò) has an Ekiti-tagged sense", () => {
    const entry = realEntries['en-o-yo-verb-rtjhekLI'];
    expect(entry).toBeDefined();
    expect(hasNonstandardSense(entry)).toBe(true);
  });
});

describe('deriveStandardForms', () => {
  it('always includes the canonical value', () => {
    const entry = makeEntry({ canonicalForm: { value: 'ìlé', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'ìlé' } });
    expect(deriveStandardForms(entry)).toEqual(['ìlé']);
  });

  it('includes alt forms tagged only with standard tags, excludes dialect/archaic-tagged ones', () => {
    const entry = makeEntry({
      canonicalForm: { value: 'a', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'a' },
      altForms: [
        { form: 'b', tags: ['alternative'] },
        { form: 'c', tags: ['Ekiti'] },
        { form: 'd', tags: [] },
      ],
    });
    expect(deriveStandardForms(entry)).toEqual(['a', 'b', 'd']);
  });
});

describe('deriveGlosses', () => {
  it('flattens every sense\'s glosses without filtering by tag - even dialectal ones', () => {
    const entry = makeEntry({
      senses: [
        { id: 's1', glosses: ['first meaning'], rawGlosses: [], tags: [], examples: [], links: [], altOf: [] },
        { id: 's2', glosses: ['dialect meaning'], rawGlosses: [], tags: ['Ekiti'], examples: [], links: [], altOf: [] },
      ],
    });
    expect(deriveGlosses(entry)).toEqual(['first meaning', 'dialect meaning']);
  });
});

describe('deriveAltOfTargets', () => {
  it('collects distinct alt_of targets across all senses, preserving first-seen order', () => {
    const entry = makeEntry({
      senses: [
        { id: 's1', glosses: [], rawGlosses: [], tags: [], examples: [], links: [], altOf: [{ word: 'wò', extra: null }] },
        { id: 's2', glosses: [], rawGlosses: [], tags: [], examples: [], links: [], altOf: [{ word: 'wò', extra: null }, { word: 'rí', extra: null }] },
      ],
    });
    expect(deriveAltOfTargets(entry)).toEqual(['wò', 'rí']);
  });

  it("real data: 'o' is an alternative form of 'wò'", () => {
    const entry = realEntries['en-o-yo-verb-rtjhekLI'];
    expect(deriveAltOfTargets(entry)).toEqual(['wò']);
  });
});

describe('deriveComponentCandidateForms', () => {
  // Which template names count, and per-morpheme bound/free filtering, now
  // live upstream in kaikki-yoruba's own extractEtymologyMorphemes (see its
  // normalizer.test.mjs) - this function's only remaining job is reading
  // that pre-filtered list and excluding bound morphemes.
  it('extracts free (non-bound) morpheme forms, preserving order', () => {
    const entry = makeEntry({
      etymologyMorphemes: [
        { form: 'di', gloss: 'to become', bound: false, resolved: true, entryIds: ['x'] },
        { form: 'odò', gloss: 'river', bound: false, resolved: true, entryIds: ['y'] },
      ],
    });
    expect(deriveComponentCandidateForms(entry)).toEqual(['di', 'odò']);
  });

  it("real data: 'dodò' (dodo) decomposes into 'di' + 'odò'", () => {
    const entry = realEntries['en-dodo-yo-verb-TzbxtbnG'];
    expect(deriveComponentCandidateForms(entry)).toEqual(['di', 'odò']);
  });

  it('real data: "o" has no component candidates (its one etymology template, "clipping", isn\'t a recognized decomposition)', () => {
    const entry = realEntries['en-o-yo-verb-rtjhekLI'];
    expect(entry.etymologyMorphemes).toEqual([]);
    expect(deriveComponentCandidateForms(entry)).toEqual([]);
  });

  it('excludes bound morphemes (leading/trailing hyphen)', () => {
    const entry = makeEntry({
      etymologyMorphemes: [
        { form: 'à-', gloss: 'nominalizing prefix', bound: true, resolved: false, entryIds: [] },
        { form: 'kan', gloss: null, bound: false, resolved: true, entryIds: ['x'] },
      ],
    });
    expect(deriveComponentCandidateForms(entry)).toEqual(['kan']);
  });

  it('dedupes repeated forms, preserving first-seen order', () => {
    const entry = makeEntry({
      etymologyMorphemes: [
        { form: 'a', gloss: null, bound: false, resolved: true, entryIds: [] },
        { form: 'b', gloss: null, bound: false, resolved: true, entryIds: [] },
        { form: 'b', gloss: null, bound: false, resolved: true, entryIds: [] },
        { form: 'c', gloss: null, bound: false, resolved: true, entryIds: [] },
      ],
    });
    expect(deriveComponentCandidateForms(entry)).toEqual(['a', 'b', 'c']);
  });
});

describe('deriveDerivedFormTexts', () => {
  it('extracts text from term-type relation items', () => {
    const entry = realEntries['en-fa-yo-verb-OFVmd8R8'];
    expect(deriveDerivedFormTexts(entry)).toEqual(['afà', 'ọfà', 'àfọwọ́fà', 'ìfà']);
  });

  it("real data: 'kòkó' excludes the external_link (garbled dialect table) entry, keeps the real terms", () => {
    const entry = realEntries['en-koko-yo-noun-JR~s1ZLl'];
    expect(entry.derivedTerms.some((t) => t.type === 'external_link')).toBe(true);
    const derived = deriveDerivedFormTexts(entry);
    expect(derived).not.toContain('Dialect link');
    expect(derived).toContain('kókó ọmú');
  });
});

describe('deriveIndexKeys', () => {
  it('always includes the orthography-insensitive headword and canonical form', () => {
    const entry = makeEntry({
      headword: 'Ìlé',
      canonicalForm: { value: 'ilé', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'Ìlé' },
    });
    expect(deriveIndexKeys(entry)).toEqual(expect.arrayContaining(['ile']));
  });

  it('expands into every alt form when the entry has no nonstandard-tagged sense', () => {
    const entry = makeEntry({
      headword: 'a',
      canonicalForm: { value: 'a', inferenceMethod: 'fallback_headword', confidence: 0.5, originalValue: 'a' },
      altForms: [{ form: 'ọwọ́', tags: [] }],
      senses: [{ id: 's1', glosses: [], rawGlosses: [], tags: [], examples: [], links: [], altOf: [] }],
    });
    expect(deriveIndexKeys(entry)).toEqual(expect.arrayContaining(['owo']));
  });

  it('does NOT expand into alt forms when the entry has a nonstandard-tagged sense', () => {
    const entry = makeEntry({
      headword: 'a',
      canonicalForm: { value: 'a', inferenceMethod: 'fallback_headword', confidence: 0.5, originalValue: 'a' },
      altForms: [{ form: 'ọwọ́', tags: [] }],
      senses: [{ id: 's1', glosses: [], rawGlosses: [], tags: ['archaic'], examples: [], links: [], altOf: [] }],
    });
    expect(deriveIndexKeys(entry)).not.toEqual(expect.arrayContaining(['owo']));
  });
});

describe('deriveSense / deriveSenses on the real corpus', () => {
  it('runs over every real entry without throwing, and finds real component candidates and real altOfTargets', () => {
    const entries = Object.values(realEntries);
    const senses = deriveSenses(entries);
    expect(senses.length).toBe(entries.length);

    const withComponents = senses.filter((s) => s.componentCandidates.length > 0);
    const withAltOf = senses.filter((s) => s.altOfTargets.length > 0);
    expect(withComponents.length).toBeGreaterThan(0);
    expect(withAltOf.length).toBeGreaterThan(0);

    // Every componentCandidate at this stage (pre-reciprocal-synthesis) is
    // tagged etymology_template - derived_reciprocal only appears after
    // synthesizeComponentReciprocals runs.
    for (const s of withComponents) {
      expect(s.componentCandidates.every((c) => c.provenance === 'etymology_template')).toBe(true);
    }
  });

  it("regression: 'dodò' (dodo) ends up with di/odò as etymology_template component candidates", () => {
    const sense = deriveSense(realEntries['en-dodo-yo-verb-TzbxtbnG']);
    expect(sense.componentCandidates).toEqual([
      { form: 'di', provenance: 'etymology_template' },
      { form: 'odò', provenance: 'etymology_template' },
    ]);
  });
});

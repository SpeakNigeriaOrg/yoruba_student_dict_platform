import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveSenses } from './deriveSenses.js';
import { synthesizeComponentReciprocals } from './synthesizeComponentReciprocals.js';
import type { CanonicalEntries, DerivedKaikkiSense } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const realEntries: CanonicalEntries = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'entries.json'), 'utf8'));

function bySpelling(senses: DerivedKaikkiSense[], spelling: string): DerivedKaikkiSense | undefined {
  return senses.find((s) => s.canonicalForm.value === spelling || s.standardForms.includes(spelling));
}

describe('synthesizeComponentReciprocals', () => {
  it('adds a reciprocal candidate to the target and leaves the source alone', () => {
    const root: DerivedKaikkiSense = {
      entryId: 'root',
      pos: 'noun',
      etymologyNumber: null,
      headword: 'kan',
      canonicalForm: { value: 'kàn', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'kan' },
      standardForms: ['kàn'],
      glosses: [],
      altOfTargets: [],
      componentCandidates: [],
      indexKeys: [],
      derivedFormTexts: ['kánjú'], // this root is used to build "kánjú"
    };
    const compound: DerivedKaikkiSense = {
      entryId: 'compound',
      pos: 'verb',
      etymologyNumber: null,
      headword: 'kanju',
      canonicalForm: { value: 'kánjú', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'kanju' },
      standardForms: ['kánjú'],
      glosses: [],
      altOfTargets: [],
      componentCandidates: [{ form: 'jù', provenance: 'etymology_template' }], // already knows about one part
      indexKeys: [],
      derivedFormTexts: [],
    };
    const senses = [root, compound];

    synthesizeComponentReciprocals(senses);

    expect(compound.componentCandidates).toEqual([
      { form: 'jù', provenance: 'etymology_template' },
      { form: 'kàn', provenance: 'derived_reciprocal' },
    ]);
    expect(root.componentCandidates).toEqual([]); // the source itself is untouched
  });

  it('does not add a duplicate reciprocal candidate if one already exists (e.g. from a real etymology_template)', () => {
    const root: DerivedKaikkiSense = {
      entryId: 'root',
      pos: 'noun',
      etymologyNumber: null,
      headword: 'di',
      canonicalForm: { value: 'di', inferenceMethod: 'fallback_headword', confidence: 0.5, originalValue: 'di' },
      standardForms: ['di'],
      glosses: [],
      altOfTargets: [],
      componentCandidates: [],
      indexKeys: [],
      derivedFormTexts: ['dodò'],
    };
    const compound: DerivedKaikkiSense = {
      entryId: 'compound',
      pos: 'verb',
      etymologyNumber: null,
      headword: 'dodo',
      canonicalForm: { value: 'dodò', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'dodo' },
      standardForms: ['dodò'],
      glosses: [],
      altOfTargets: [],
      componentCandidates: [{ form: 'di', provenance: 'etymology_template' }, { form: 'odò', provenance: 'etymology_template' }],
      indexKeys: [],
      derivedFormTexts: [],
    };

    synthesizeComponentReciprocals([root, compound]);

    expect(compound.componentCandidates).toEqual([
      { form: 'di', provenance: 'etymology_template' },
      { form: 'odò', provenance: 'etymology_template' },
    ]);
  });

  it('runs over the full real corpus without throwing and produces at least one real derived_reciprocal candidate', () => {
    const entries = Object.values(realEntries);
    const senses = deriveSenses(entries);
    synthesizeComponentReciprocals(senses);

    const reciprocals = senses.flatMap((s) => s.componentCandidates.filter((c) => c.provenance === 'derived_reciprocal'));
    expect(reciprocals.length).toBeGreaterThan(0);
  });

  it("regression: 'dodò' keeps its real etymology_template candidates untouched by synthesis (already fully accounted for)", () => {
    const entries = Object.values(realEntries);
    const senses = deriveSenses(entries);
    synthesizeComponentReciprocals(senses);

    const dodo = senses.find((s) => s.entryId === 'en-dodo-yo-verb-TzbxtbnG');
    expect(dodo?.componentCandidates).toEqual([
      { form: 'di', provenance: 'etymology_template' },
      { form: 'odò', provenance: 'etymology_template' },
    ]);
  });
});

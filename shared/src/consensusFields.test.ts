// Telling identity disagreement from wording disagreement.
//
// The full entry fingerprint bundles spelling, syllables, definition and cited etymology, and that
// stays right: a definition cannot be judged without knowing which word it belongs to. But bundled,
// two very different situations looked identical - a tone-mark dispute and three people wording one
// gloss three reasonable ways both came out as "contested", with nothing saying which.

import { describe, expect, it } from 'vitest';
import { differingFields, fingerprintIdentity, fingerprintOutcome, summarizeConsensus } from './consensus.js';
import type { ContributionRecord, EntryOutcome } from './consensus.js';

const base: EntryOutcome = {
  kind: 'entry',
  displayText: 'ojú sánmà',
  syllables: ['o', 'jú', 'sán', 'mà'],
  definitionText: 'the sky',
  citedEntryId: 'en-yo-noun-1',
};
const entry = (over: Partial<EntryOutcome> = {}): EntryOutcome => ({ ...base, ...over });

describe('differingFields', () => {
  it('says nothing when there is only one claim', () => {
    expect(differingFields([entry()])).toEqual([]);
  });

  it('names the definition when only the wording varies', () => {
    expect(differingFields([entry(), entry({ definitionText: 'the sky above us' })])).toEqual(['definition']);
  });

  it('names the spelling when a tone mark differs', () => {
    expect(differingFields([entry(), entry({ displayText: 'oju sanma' })])).toEqual(['spelling']);
  });

  it('names every field that varies, in reading order', () => {
    expect(
      differingFields([entry(), entry({ displayText: 'oju sanma', definitionText: 'sky', citedEntryId: 'en-yo-noun-2' })]),
    ).toEqual(['spelling', 'definition', 'etymology']);
  });

  it('ignores differences the fingerprint also ignores', () => {
    // Case in an English gloss is not a claim. What this reports and what makes two claims count as
    // distinct must never come apart, so both sides use the same normalization.
    expect(differingFields([entry({ definitionText: 'The Sky' }), entry({ definitionText: 'the sky' })])).toEqual([]);
  });

  it('treats a null definition as different from a written one', () => {
    expect(differingFields([entry({ definitionText: null }), entry()])).toEqual(['definition']);
  });

  it('reports components for the etymology axis', () => {
    const a = { kind: 'etymology' as const, atomic: false, components: ['oju_face'] };
    const b = { kind: 'etymology' as const, atomic: false, components: ['ile_house'] };
    expect(differingFields([a, b])).toEqual(['components']);
    expect(differingFields([a, a])).toEqual([]);
  });
});

describe('fingerprintIdentity', () => {
  it('is the same for two claims that differ only in wording', () => {
    expect(fingerprintIdentity(entry())).toBe(fingerprintIdentity(entry({ definitionText: 'a totally different gloss' })));
  });

  it('differs when the spelling, syllables or cited etymology differ', () => {
    const id = fingerprintIdentity(entry());
    expect(fingerprintIdentity(entry({ displayText: 'oju sanma' }))).not.toBe(id);
    expect(fingerprintIdentity(entry({ syllables: ['ojú', 'sánmà'] }))).not.toBe(id);
    expect(fingerprintIdentity(entry({ citedEntryId: 'en-yo-noun-2' }))).not.toBe(id);
  });

  it('does not collide with the full fingerprint of the same outcome', () => {
    // Separately namespaced, so an identity hash can never be mistaken for a claim hash if the two
    // ever meet in one collection - and dropping a field can never accidentally produce a string
    // the other function would also produce.
    expect(fingerprintIdentity(entry())).not.toBe(fingerprintOutcome(entry()));
    expect(fingerprintIdentity(entry(({ definitionText: null })))).not.toBe(fingerprintOutcome(entry({ definitionText: null })));
  });
});

describe('summarizeConsensus reports the shape of the disagreement', () => {
  const contribution = (id: string, outcome: EntryOutcome, fingerprint: string): ContributionRecord => ({
    contributionId: id,
    submittedBy: id,
    submitterLabel: id,
    submittedAt: '2026-08-01T00:00:00.000Z',
    valueFingerprint: fingerprint,
    resolvedValue: outcome,
  });

  it('flags a wording-only split, so the identity is not read as contested', () => {
    // The case that motivated this: everyone agrees what the word IS.
    const summary = summarizeConsensus([
      contribution('ada', entry(), 'fp-a'),
      contribution('ben', entry({ definitionText: 'the sky above us' }), 'fp-b'),
      contribution('cy', entry({ definitionText: 'the open sky' }), 'fp-c'),
    ]);

    expect(summary.isContested).toBe(true);
    expect(summary.wordingOnly).toBe(true);
    expect(summary.differingFields).toEqual(['definition']);
  });

  it('does NOT flag wording-only when the spelling also differs', () => {
    const summary = summarizeConsensus([
      contribution('ada', entry(), 'fp-a'),
      contribution('ben', entry({ displayText: 'oju sanma', definitionText: 'sky' }), 'fp-b'),
    ]);
    expect(summary.wordingOnly).toBe(false);
    expect(summary.differingFields).toEqual(['spelling', 'definition']);
  });

  it('is quiet when everyone agrees', () => {
    const summary = summarizeConsensus([
      contribution('ada', entry(), 'fp-a'),
      contribution('ben', entry(), 'fp-a'),
    ]);
    expect(summary.differingFields).toEqual([]);
    // One claim is not a disagreement to characterise, however many people hold it.
    expect(summary.wordingOnly).toBe(false);
  });

  it('compares distinct CLAIMS, not raw contributions', () => {
    // Five people holding two positions is a two-way difference, not a five-way one.
    const summary = summarizeConsensus([
      contribution('ada', entry(), 'fp-a'),
      contribution('ben', entry(), 'fp-a'),
      contribution('cy', entry(), 'fp-a'),
      contribution('dee', entry({ definitionText: 'the sky above us' }), 'fp-b'),
      contribution('eve', entry({ definitionText: 'the sky above us' }), 'fp-b'),
    ]);
    expect(summary.tally).toHaveLength(2);
    expect(summary.differingFields).toEqual(['definition']);
    expect(summary.wordingOnly).toBe(true);
  });
});

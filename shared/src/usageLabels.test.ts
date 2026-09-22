import { describe, expect, it } from 'vitest';
import { canonicalUsageLabels, isKnownUsageLabel, renderLabelTemplate, USAGE_LABELS } from './usageLabels.js';
import { acceptsOnlyInDerivedTerms, isKnownPartOfSpeech } from './partsOfSpeech.js';

describe('usage labels', () => {
  it('holds only labels Wiktionary defines - no ad hoc text passed off as a label', () => {
    // Checked against Module:labels/data on 2026-09-22. "in compounds" is deliberately absent:
    // {{lb}} would display it, but as uncategorised free text.
    expect(USAGE_LABELS.map((l) => l.value).sort()).toEqual(['archaic', 'dated', 'historical', 'obsolete', 'rare']);
    expect(isKnownUsageLabel('in compounds')).toBe(false);
    expect(isKnownUsageLabel('obsolete')).toBe(true);
  });

  it('canonicalizes: de-duplicated, fixed order, unknown values dropped', () => {
    expect(canonicalUsageLabels(['rare', 'obsolete', 'rare', 'bogus'])).toEqual(['obsolete', 'rare']);
  });

  it('renders one {{lb}} template, or nothing', () => {
    expect(renderLabelTemplate(['obsolete'])).toBe('{{lb|yo|obsolete}}');
    expect(renderLabelTemplate(['rare', 'archaic'])).toBe('{{lb|yo|archaic|rare}}');
    expect(renderLabelTemplate([])).toBe('');
  });
});

describe('acceptsOnlyInDerivedTerms', () => {
  it('rules out affixes and characters, which never were separate words', () => {
    for (const pos of ['prefix', 'interfix', 'suffix', 'character']) {
      expect(isKnownPartOfSpeech(pos)).toBe(true);
      expect(acceptsOnlyInDerivedTerms(pos)).toBe(false);
    }
  });

  it('allows words of every other class, particles included', () => {
    for (const pos of ['verb', 'noun', 'particle', 'pron']) expect(acceptsOnlyInDerivedTerms(pos)).toBe(true);
  });

  it('allows it when the part of speech is unknown', () => {
    expect(acceptsOnlyInDerivedTerms(null)).toBe(true);
  });
});

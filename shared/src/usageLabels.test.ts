import { describe, expect, it } from 'vitest';
import { canonicalUsageLabels, isKnownUsageLabel, renderLabelTemplate, USAGE_LABELS } from './usageLabels.js';
import {
  fixedOnlyInDerivedTerms,
  isKnownPartOfSpeech,
  isStandaloneEntry,
  resolveOnlyInDerivedTerms,
  standaloneEntrySql,
} from './partsOfSpeech.js';

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

describe('not a standalone word - one field for affixes and fossilized words alike', () => {
  it('is always on for an affix: it never was a separate word', () => {
    for (const pos of ['prefix', 'interfix', 'suffix']) {
      expect(isKnownPartOfSpeech(pos)).toBe(true);
      expect(fixedOnlyInDerivedTerms(pos)).toBe(true);
      expect(resolveOnlyInDerivedTerms(pos, false)).toBe(true);
      expect(isStandaloneEntry(pos, false)).toBe(false);
    }
  });

  it('is always off for a letter, which is not a piece of a word', () => {
    expect(resolveOnlyInDerivedTerms('character', true)).toBe(false);
  });

  it("is the reviewer's call for any other word, particles included - lá is a verb that fossilized", () => {
    for (const pos of ['verb', 'noun', 'particle', 'pron', null]) {
      expect(fixedOnlyInDerivedTerms(pos)).toBeNull();
      expect(isStandaloneEntry(pos, true)).toBe(false);
      expect(isStandaloneEntry(pos, false)).toBe(true);
    }
  });

  it('has a SQL form that also catches an affix known only from its pin', () => {
    expect(standaloneEntrySql('g', 'c')).toBe(
      "not (g.only_in_derived_terms or coalesce(g.pos, c.pin ->> 'pos') in ('prefix', 'interfix', 'suffix'))",
    );
  });
});

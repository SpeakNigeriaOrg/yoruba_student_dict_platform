import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_THRESHOLD,
  fingerprintOutcome,
  resolveEntryOutcome,
  resolveEtymologyOutcome,
  summarizeConsensus,
  type ContributionRecord,
  type EntryObservedState,
  type EntryOutcome,
} from './consensus.js';

const OBSERVED: EntryObservedState = {
  displayText: 'ikun',
  syllables: ['i', 'kun'],
  definition: 'stomach',
};

function entryOutcome(over: Partial<EntryOutcome> = {}): EntryOutcome {
  return { kind: 'entry', displayText: 'ikun', syllables: ['i', 'kun'], definitionText: 'stomach', ...over };
}

let seq = 0;
function contribution(fingerprint: string, submittedBy: string, submittedAt: string, outcome?: EntryOutcome): ContributionRecord {
  seq += 1;
  return {
    contributionId: `c${seq}`,
    submittedBy,
    submitterLabel: submittedBy,
    submittedAt,
    valueFingerprint: fingerprint,
    resolvedValue: outcome ?? entryOutcome(),
  };
}

describe('resolveEntryOutcome', () => {
  it('keep_ours asserts the state as observed', () => {
    expect(resolveEntryOutcome(OBSERVED, { action: 'keep_ours', definitionAction: 'confirm' })).toEqual({
      kind: 'entry',
      displayText: 'ikun',
      syllables: ['i', 'kun'],
      definitionText: 'stomach',
    });
  });

  it('adopt_kaikki asserts the new spelling', () => {
    const out = resolveEntryOutcome(OBSERVED, {
      action: 'adopt_kaikki',
      newDisplayText: 'ikùn',
      definitionAction: 'confirm',
    });
    expect(out.displayText).toBe('ikùn');
  });

  it('select_candidate does NOT change the spelling', () => {
    // It resolves which Kaikki sense the word matches; it is not a rename.
    // applyEntryDecision only writes display_text for adopt_kaikki, so an
    // outcome that claimed otherwise would not describe what applying it does.
    const out = resolveEntryOutcome(OBSERVED, {
      action: 'select_candidate',
      candidateForm: 'ikùn',
      definitionAction: 'confirm',
    });
    expect(out.displayText).toBe('ikun');
  });

  it('accept_programmatic recomputes syllables from the spelling being adopted', () => {
    const out = resolveEntryOutcome(OBSERVED, {
      action: 'adopt_kaikki',
      newDisplayText: 'ikùn',
      syllableAction: 'accept_programmatic',
      definitionAction: 'confirm',
    });
    // Split from 'ikùn' (post-adoption), not from 'ikun'.
    expect(out.syllables).toEqual(['i', 'kùn']);
  });

  it('keep_manual leaves the observed syllables alone', () => {
    const out = resolveEntryOutcome(OBSERVED, {
      action: 'keep_ours',
      syllableAction: 'keep_manual',
      definitionAction: 'confirm',
    });
    expect(out.syllables).toEqual(['i', 'kun']);
  });

  it("definitionAction 'custom' asserts the supplied text; 'confirm' asserts the observed text", () => {
    expect(
      resolveEntryOutcome(OBSERVED, { action: 'keep_ours', definitionAction: 'custom', definitionText: 'belly' })
        .definitionText,
    ).toBe('belly');
    expect(
      resolveEntryOutcome(OBSERVED, { action: 'keep_ours', definitionAction: 'confirm' }).definitionText,
    ).toBe('stomach');
  });

  it('carries a null observed definition through as null', () => {
    const out = resolveEntryOutcome({ ...OBSERVED, definition: null }, { action: 'keep_ours', definitionAction: 'confirm' });
    expect(out.definitionText).toBeNull();
  });
});

describe('fingerprintOutcome', () => {
  it('is the reason this module exists: keep_ours and select_candidate of the observed form AGREE', () => {
    // The failure mode being guarded: comparing actions instead of outcomes
    // would score these as disagreement, and both real spelling decisions in
    // production are select_candidate.
    const a = resolveEntryOutcome(OBSERVED, { action: 'keep_ours', definitionAction: 'confirm' });
    const b = resolveEntryOutcome(OBSERVED, {
      action: 'select_candidate',
      candidateForm: 'ikun',
      definitionAction: 'confirm',
    });
    expect(fingerprintOutcome(a)).toBe(fingerprintOutcome(b));
  });

  it('ignores provenance - same claim reached via different Kaikki records agrees', () => {
    const a = resolveEntryOutcome(OBSERVED, { action: 'keep_ours', definitionAction: 'custom', definitionText: 'belly' });
    const b = resolveEntryOutcome(OBSERVED, {
      action: 'select_candidate',
      candidateForm: 'somethingelse',
      definitionAction: 'custom',
      definitionText: 'belly',
    });
    expect(fingerprintOutcome(a)).toBe(fingerprintOutcome(b));
  });

  it('distinguishes different spellings', () => {
    expect(fingerprintOutcome(entryOutcome({ displayText: 'ikun' }))).not.toBe(
      fingerprintOutcome(entryOutcome({ displayText: 'ikùn' })),
    );
  });

  it('distinguishes different syllable splits', () => {
    expect(fingerprintOutcome(entryOutcome({ syllables: ['i', 'kun'] }))).not.toBe(
      fingerprintOutcome(entryOutcome({ syllables: ['ik', 'un'] })),
    );
  });

  describe('normalization', () => {
    it('folds case in the definition only', () => {
      expect(fingerprintOutcome(entryOutcome({ definitionText: 'Stomach' }))).toBe(
        fingerprintOutcome(entryOutcome({ definitionText: 'stomach' })),
      );
    });

    it('does NOT fold case in the spelling', () => {
      // Agẹmọ is a month name; folding would merge proper nouns with common ones.
      expect(fingerprintOutcome(entryOutcome({ displayText: 'Agẹmọ' }))).not.toBe(
        fingerprintOutcome(entryOutcome({ displayText: 'agẹmọ' })),
      );
    });

    it('never folds diacritics or underdots - they are the semantic content', () => {
      const forms = ['owo', 'owó', 'owò', 'ọwọ', 'ọwọ́'];
      const prints = new Set(forms.map((displayText) => fingerprintOutcome(entryOutcome({ displayText }))));
      expect(prints.size).toBe(forms.length);
    });

    it('normalizes NFC so decomposed and precomposed input agree', () => {
      // The same visible word arrives differently depending on keyboard/OS;
      // without NFC two people who typed the identical form would disagree.
      const precomposed = 'ikùn'.normalize('NFC');
      const decomposed = 'ikùn'.normalize('NFD');
      expect(precomposed).not.toBe(decomposed);
      expect(fingerprintOutcome(entryOutcome({ displayText: decomposed }))).toBe(
        fingerprintOutcome(entryOutcome({ displayText: precomposed })),
      );
    });

    it('trims and collapses whitespace', () => {
      expect(fingerprintOutcome(entryOutcome({ definitionText: '  a  long   gloss ' }))).toBe(
        fingerprintOutcome(entryOutcome({ definitionText: 'a long gloss' })),
      );
    });

    it('keeps a null definition distinct from an empty one', () => {
      expect(fingerprintOutcome(entryOutcome({ definitionText: null }))).not.toBe(
        fingerprintOutcome(entryOutcome({ definitionText: '' })),
      );
    });

    it('never emits a NUL byte, which Postgres text cannot store', () => {
      // Regression guard: the null-definition marker was \u0000 first, so every
      // entry without a definition produced a fingerprint that threw
      // 'invalid byte sequence for encoding "UTF8": 0x00' on insert.
      const cases: EntryOutcome[] = [
        entryOutcome({ definitionText: null }),
        entryOutcome({ definitionText: '' }),
        entryOutcome({ syllables: [] }),
        entryOutcome({ displayText: '', syllables: [], definitionText: null }),
      ];
      for (const outcome of cases) {
        expect(fingerprintOutcome(outcome)).not.toContain('\u0000');
      }
      expect(
        fingerprintOutcome(resolveEtymologyOutcome({ components: [] }, { componentsAction: 'confirm_atomic' })),
      ).not.toContain('\u0000');
    });

    it('cannot be collided by field-boundary ambiguity', () => {
      // A printable separator would let these two collide.
      expect(fingerprintOutcome(entryOutcome({ displayText: 'a', syllables: ['b'] }))).not.toBe(
        fingerprintOutcome(entryOutcome({ displayText: 'ab', syllables: [] })),
      );
    });
  });
});

describe('resolveEtymologyOutcome', () => {
  const observed = { components: ['comp_a', 'comp_b'] };

  it('accept_proposed and custom replace the component list', () => {
    expect(resolveEtymologyOutcome(observed, { componentsAction: 'accept_proposed', components: ['x'] }).components).toEqual(['x']);
    expect(resolveEtymologyOutcome(observed, { componentsAction: 'custom', components: ['y', 'z'] }).components).toEqual(['y', 'z']);
  });

  it('the other three leave the observed list untouched', () => {
    for (const componentsAction of ['confirm_atomic', 'confirm_existing', 'reject_proposed'] as const) {
      expect(resolveEtymologyOutcome(observed, { componentsAction }).components).toEqual(['comp_a', 'comp_b']);
    }
  });

  it('preserves component ORDER as a distinct claim', () => {
    const ab = resolveEtymologyOutcome(observed, { componentsAction: 'custom', components: ['a', 'b'] });
    const ba = resolveEtymologyOutcome(observed, { componentsAction: 'custom', components: ['b', 'a'] });
    expect(fingerprintOutcome(ab)).not.toBe(fingerprintOutcome(ba));
  });

  it('confirm_atomic does not fingerprint the same as confirm_existing', () => {
    // On a word with no components both produce an empty list, but "this word
    // has no parts" is a different claim from "the parts on record are right".
    const empty = { components: [] };
    const atomic = resolveEtymologyOutcome(empty, { componentsAction: 'confirm_atomic' });
    const existing = resolveEtymologyOutcome(empty, { componentsAction: 'confirm_existing' });
    expect(fingerprintOutcome(atomic)).not.toBe(fingerprintOutcome(existing));
  });

  it('confirm_existing and reject_proposed DO agree - both bless the current list', () => {
    const a = resolveEtymologyOutcome(observed, { componentsAction: 'confirm_existing' });
    const b = resolveEtymologyOutcome(observed, { componentsAction: 'reject_proposed' });
    expect(fingerprintOutcome(a)).toBe(fingerprintOutcome(b));
  });

  it('never collides with an entry outcome', () => {
    expect(fingerprintOutcome(resolveEtymologyOutcome({ components: [] }, { componentsAction: 'confirm_atomic' }))).not.toBe(
      fingerprintOutcome(entryOutcome()),
    );
  });
});

describe('summarizeConsensus', () => {
  const T1 = '2026-08-01T00:00:00.000Z';
  const T2 = '2026-08-02T00:00:00.000Z';
  const T3 = '2026-08-03T00:00:00.000Z';

  it('reports none for no contributions and no decision', () => {
    const s = summarizeConsensus([]);
    expect(s.bucket).toBe('none');
    expect(s.winner).toBeNull();
    expect(s.totalVotes).toBe(0);
  });

  it('a lone contribution is provisional but below the bar', () => {
    const s = summarizeConsensus([contribution('fp-a', 'u1', T1)]);
    expect(s.bucket).toBe('single');
    expect(s.agreementCount).toBe(1);
    expect(s.meetsThreshold).toBe(false);
    expect(s.isContested).toBe(false);
  });

  it('two agreeing contributions are ready for bulk confirmation', () => {
    const s = summarizeConsensus([contribution('fp-a', 'u1', T1), contribution('fp-a', 'u2', T2)]);
    expect(s.bucket).toBe('ready');
    expect(s.agreementCount).toBe(2);
    expect(s.meetsThreshold).toBe(true);
    expect(s.winner?.voters).toEqual(['u1', 'u2']);
    expect(s.tally).toHaveLength(1);
  });

  it('honours AGREEMENT_THRESHOLD rather than a hardcoded 2', () => {
    const votes = Array.from({ length: AGREEMENT_THRESHOLD }, (_, i) => contribution('fp-a', `u${i}`, T1));
    expect(summarizeConsensus(votes).meetsThreshold).toBe(true);
    expect(summarizeConsensus(votes.slice(0, AGREEMENT_THRESHOLD - 1)).meetsThreshold).toBe(false);
  });

  it('any disagreement is contested, even with a clear majority', () => {
    // 3-vs-1 still means someone saw something the others did not.
    const s = summarizeConsensus([
      contribution('fp-a', 'u1', T1),
      contribution('fp-a', 'u2', T1),
      contribution('fp-a', 'u3', T1),
      contribution('fp-b', 'u4', T2),
    ]);
    expect(s.bucket).toBe('contested');
    expect(s.isContested).toBe(true);
    // ...but the majority is still offered, so the UI can resolve it in one click.
    expect(s.winner?.fingerprint).toBe('fp-a');
    expect(s.agreementCount).toBe(3);
    expect(s.meetsThreshold).toBe(true);
  });

  it('a tie has no winner to offer', () => {
    const s = summarizeConsensus([contribution('fp-a', 'u1', T1), contribution('fp-b', 'u2', T2)]);
    expect(s.bucket).toBe('contested');
    expect(s.isTied).toBe(true);
    expect(s.winner).toBeNull();
    expect(s.agreementCount).toBe(0);
  });

  it('orders the tally by support, breaking ties by who claimed it first', () => {
    const s = summarizeConsensus([
      contribution('fp-late', 'u1', T3),
      contribution('fp-early', 'u2', T1),
      contribution('fp-top', 'u3', T2),
      contribution('fp-top', 'u4', T3),
    ]);
    expect(s.tally.map((t) => t.fingerprint)).toEqual(['fp-top', 'fp-early', 'fp-late']);
  });

  describe('against an existing golden decision', () => {
    it('agreeing contributions after the decision change nothing', () => {
      const s = summarizeConsensus([contribution('fp-a', 'u9', T3)], { fingerprint: 'fp-a', decidedAt: T2 });
      expect(s.bucket).toBe('golden');
      expect(s.dissentsFromGolden).toEqual([]);
    });

    it('a later disagreeing contribution re-flags the word', () => {
      const s = summarizeConsensus([contribution('fp-b', 'u9', T3)], { fingerprint: 'fp-a', decidedAt: T2 });
      expect(s.bucket).toBe('dissent_on_golden');
      expect(s.dissentsFromGolden.map((d) => d.fingerprint)).toEqual(['fp-b']);
    });

    it('a contribution the curator already overruled is NOT dissent', () => {
      // Counting pre-decision disagreement would leave every overruled word
      // flagged forever, which would make the flag meaningless.
      const s = summarizeConsensus([contribution('fp-b', 'u1', T1)], { fingerprint: 'fp-a', decidedAt: T2 });
      expect(s.bucket).toBe('golden');
      expect(s.dissentsFromGolden).toEqual([]);
    });

    it('stays golden when a decision predates fingerprinting', () => {
      const s = summarizeConsensus([contribution('fp-b', 'u1', T3)], { fingerprint: null, decidedAt: T2 });
      expect(s.bucket).toBe('golden');
      expect(s.dissentsFromGolden).toEqual([]);
    });

    it('accepts Date objects as well as ISO strings', () => {
      const s = summarizeConsensus([contribution('fp-b', 'u1', T3)], {
        fingerprint: 'fp-a',
        decidedAt: new Date(T2),
      });
      expect(s.bucket).toBe('dissent_on_golden');
    });
  });

  it('attributes every claim to its voters for the conflict screen', () => {
    const s = summarizeConsensus([
      contribution('fp-a', 'u1', T1),
      contribution('fp-a', 'u2', T2),
      contribution('fp-b', 'u3', T3),
    ]);
    const a = s.tally.find((t) => t.fingerprint === 'fp-a')!;
    const b = s.tally.find((t) => t.fingerprint === 'fp-b')!;
    expect(a.voterLabels).toEqual(['u1', 'u2']);
    expect(b.voterLabels).toEqual(['u3']);
    expect(a.earliestSubmittedAt).toBe(T1);
  });
});

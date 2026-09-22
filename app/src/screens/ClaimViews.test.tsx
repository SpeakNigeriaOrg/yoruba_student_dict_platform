// @vitest-environment jsdom
//
// Part of speech and usage (0029) as the curator sees them in a tally.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { summarizeConsensus, type EntryOutcome } from '@yoruba-student-dict-platform/shared';
import { CurrentRecord, DisagreementNote, OutcomeSummary } from './ClaimViews.js';

afterEach(cleanup);

const base: EntryOutcome = {
  kind: 'entry',
  displayText: 'lá',
  syllables: ['lá'],
  definitionText: 'to be big',
  citedEntryId: null,
  pos: 'particle',
  usageLabels: [],
  onlyInDerivedTerms: false,
};

describe('usage in the claim views', () => {
  it('shows a claim\'s part of speech, labels and flag on one line', () => {
    render(<OutcomeSummary outcome={{ ...base, pos: 'verb', usageLabels: ['obsolete'], onlyInDerivedTerms: true }} />);
    expect(screen.getByLabelText('Part of speech and usage')).toHaveTextContent(
      'verb · obsolete · survives only inside other words',
    );
  });

  it('says nothing about usage for a claim that predates it, rather than inventing "no part of speech"', () => {
    const { pos: _p, usageLabels: _u, onlyInDerivedTerms: _o, ...legacy } = base;
    render(<OutcomeSummary outcome={legacy} />);
    expect(screen.queryByLabelText('Part of speech and usage')).not.toBeInTheDocument();
  });

  it('shows the record\'s own part of speech beside the claims', () => {
    render(
      <CurrentRecord
        axis="entry"
        displayText="lá"
        syllables={['lá']}
        definition="to be big"
        citedEntryId={null}
        usage={{ pos: 'particle', usageLabels: [], onlyInDerivedTerms: false }}
      />,
    );
    expect(screen.getByLabelText('Part of speech and usage')).toHaveTextContent('particle');
  });

  it('names the part of speech as what two claims differ on', () => {
    const fp = (o: EntryOutcome) => JSON.stringify(o);
    const a = base;
    const b = { ...base, pos: 'verb' };
    const summary = summarizeConsensus([
      { contributionId: '1', submittedBy: 'ada', submittedAt: '2026-09-01T00:00:00Z', valueFingerprint: fp(a), resolvedValue: a },
      { contributionId: '2', submittedBy: 'ben', submittedAt: '2026-09-02T00:00:00Z', valueFingerprint: fp(b), resolvedValue: b },
    ]);
    render(<DisagreementNote summary={summary} />);
    expect(screen.getByLabelText('What differs')).toHaveTextContent('They differ on the part of speech.');
  });
});

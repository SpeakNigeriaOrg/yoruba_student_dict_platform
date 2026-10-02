// @vitest-environment jsdom
//
// Part of speech and usage (0029) as the curator sees them in a tally.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { summarizeConsensus, type EntryOutcome } from '@yoruba-student-dict-platform/shared';
import { CurrentRecord, DisagreementNote, OutcomeSummary, WiktionaryEtymologyText } from './ClaimViews.js';

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
      'verb · obsolete · not a standalone word',
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

describe("Wiktionary's etymology text", () => {
  it('shows a short text whole, and nothing at all when there is none', () => {
    const { rerender } = render(<WiktionaryEtymologyText text="From ọmọ + ọba." />);
    expect(screen.getByLabelText("Wiktionary's etymology")).toHaveTextContent("Wiktionary's etymology: From ọmọ + ọba.");
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<WiktionaryEtymologyText text="  " />);
    expect(screen.queryByLabelText("Wiktionary's etymology")).not.toBeInTheDocument();
  });

  it('cuts a very long text at a word, with a control to show all of it', async () => {
    const long = `${'Cognate with Igala and Edo forms '.repeat(12)}and the end.`;
    render(<WiktionaryEtymologyText text={long} />);
    const note = screen.getByLabelText("Wiktionary's etymology");
    expect(note).not.toHaveTextContent('and the end.');
    expect(note).toHaveTextContent('…');
    screen.getByRole('button', { name: 'Show all' }).click();
    expect(await screen.findByRole('button', { name: 'Show less' })).toBeInTheDocument();
    expect(screen.getByLabelText("Wiktionary's etymology")).toHaveTextContent('and the end.');
  });

  it("is part of the etymology record's baseline", () => {
    render(
      <CurrentRecord
        axis="etymology"
        displayText="sọ̀rọ̀"
        syllables={['sọ̀', 'rọ̀']}
        definition="to speak"
        citedEntryId={null}
        components={[]}
        wiktionaryEtymologyText="Contraction of sọ + ọ̀rọ̀."
      />,
    );
    expect(screen.getByLabelText('What the record says now')).toHaveTextContent('Contraction of sọ + ọ̀rọ̀.');
  });
});

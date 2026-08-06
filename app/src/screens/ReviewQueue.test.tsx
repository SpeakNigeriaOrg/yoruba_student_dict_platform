// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ReviewQueue } from './ReviewQueue.js';
import type { ConsensusGroup } from '../api.js';
import type { ConsensusBucket, ConsensusTallyEntry, EntryOutcome } from '@yoruba-student-dict-platform/shared';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function outcome(over: Partial<EntryOutcome> = {}): EntryOutcome {
  return { kind: 'entry', displayText: 'ikun', syllables: ['i', 'kun'], definitionText: 'stomach', citedEntryId: null, ...over };
}

function claim(fingerprint: string, count: number, voters: string[], over: Partial<EntryOutcome> = {}): ConsensusTallyEntry {
  return {
    fingerprint,
    outcome: outcome(over),
    count,
    voters,
    voterLabels: voters,
    earliestSubmittedAt: '2026-08-01T00:00:00.000Z',
  };
}

function group(wordId: string, bucket: ConsensusBucket, tally: ConsensusTallyEntry[], winnerIndex: number | null = 0): ConsensusGroup {
  const winner = winnerIndex === null ? null : (tally[winnerIndex] ?? null);
  return {
    wordId,
    displayText: `display_${wordId}`,
    currentDefinition: 'stomach',
    axis: 'entry',
    decidedAt: bucket === 'dissent_on_golden' ? '2026-08-02T00:00:00.000Z' : null,
    decidedByEmail: bucket === 'dissent_on_golden' ? 'curator@example.com' : null,
    summary: {
      tally,
      winner,
      totalVotes: tally.reduce((n, t) => n + t.count, 0),
      agreementCount: winner?.count ?? 0,
      isContested: tally.length > 1,
      isTied: false,
      meetsThreshold: (winner?.count ?? 0) >= 2,
      dissentsFromGolden: bucket === 'dissent_on_golden' ? [tally[0]] : [],
      bucket,
    },
  };
}

const NO_DRIFT = { items: [], counts: { unchanged: 3, content_changed: 0, re_identified: 0, disappeared: 0 }, exempt: 1, uncited: 0 };

function pin(glosses: string[], etymologyNumber = '1') {
  return { etymologyNumber, pos: 'noun', canonicalForm: 'ikun', glosses, etymologyText: null };
}

function mockFetch(groups: ConsensusGroup[], confirmResult?: unknown, drift: unknown = NO_DRIFT) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => confirmResult ?? { confirmed: [{ wordId: 'w', axis: 'entry', fingerprint: 'fp', agreementCount: 2 }], skipped: [] },
      });
    }
    if (url.includes('/upstream-drift')) return Promise.resolve({ ok: true, json: async () => drift });
    return Promise.resolve({ ok: true, json: async () => ({ groups }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const READY = group('ready1', 'ready', [claim('fp-a', 2, ['ada', 'ben'])]);
const CONTESTED = group('con1', 'contested', [claim('fp-a', 2, ['ada', 'ben']), claim('fp-b', 1, ['cy'], { definitionText: 'belly' })]);
const SINGLE = group('sing1', 'single', [claim('fp-a', 1, ['ada'])]);
const DISSENT = group('dis1', 'dissent_on_golden', [claim('fp-b', 1, ['cy'], { definitionText: 'belly' })]);


describe('ReviewQueue: upstream drift', () => {
  it('says so plainly when every cited etymology still matches', async () => {
    mockFetch([READY]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Upstream drift status')).toHaveTextContent('still matches Wiktionary'),
    );
  });

  it('counts exempt and unlinked words separately, so "no drift" is not mistaken for full coverage', async () => {
    mockFetch([READY], undefined, { ...NO_DRIFT, exempt: 9, uncited: 4 });
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => {
      const status = screen.getByLabelText('Upstream drift status');
      expect(status).toHaveTextContent('9 exempt');
      expect(status).toHaveTextContent('4 not linked yet');
    });
  });

  it('shows an edited etymology with both versions side by side', async () => {
    mockFetch([READY], undefined, {
      items: [
        {
          wordId: 'w1',
          displayText: 'ikun',
          citedEntryId: 'en-yo-noun-OLD',
          kind: 'content_changed',
          pin: pin(['stomach']),
          current: pin(['belly', 'abdomen']),
        },
      ],
      counts: { unchanged: 0, content_changed: 1, re_identified: 0, disappeared: 0 },
      exempt: 0,
      uncited: 0,
    });
    render(<ReviewQueue onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Wiktionary edited an etymology we cite')).toBeInTheDocument());
    const comparison = screen.getByLabelText('Upstream change for ikun');
    expect(comparison).toHaveTextContent('stomach');
    expect(comparison).toHaveTextContent('belly; abdomen');
  });

  it('re-pins the same etymology when the curator accepts the new upstream content', async () => {
    const fetchMock = mockFetch([READY], undefined, {
      items: [
        {
          wordId: 'w1',
          displayText: 'ikun',
          citedEntryId: 'en-yo-noun-SAME',
          kind: 'content_changed',
          pin: pin(['stomach']),
          current: pin(['belly']),
        },
      ],
      counts: { unchanged: 0, content_changed: 1, re_identified: 0, disappeared: 0 },
      exempt: 0,
      uncited: 0,
    });
    const user = userEvent.setup();
    render(<ReviewQueue onOpenWord={() => {}} />);

    await waitFor(() => screen.getByRole('button', { name: 'Accept the new upstream content' }));
    await user.click(screen.getByRole('button', { name: 'Accept the new upstream content' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/api/upstream-drift/repin');
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ wordId: 'w1', entryId: 'en-yo-noun-SAME' });
    });
  });

  it('offers a re-link to the etymology now carrying the pinned content', async () => {
    const fetchMock = mockFetch([READY], undefined, {
      items: [
        {
          wordId: 'w1',
          displayText: 'ikun',
          citedEntryId: 'en-yo-noun-GONE',
          kind: 're_identified',
          pin: pin(['stomach']),
          current: pin(['stomach']),
          proposedEntryId: 'en-yo-noun-MOVED',
        },
      ],
      counts: { unchanged: 0, content_changed: 0, re_identified: 1, disappeared: 0 },
      exempt: 0,
      uncited: 0,
    });
    const user = userEvent.setup();
    render(<ReviewQueue onOpenWord={() => {}} />);

    await waitFor(() => screen.getByRole('button', { name: /Re-link to en-yo-noun-MOVED/ }));
    await user.click(screen.getByRole('button', { name: /Re-link to en-yo-noun-MOVED/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/api/upstream-drift/repin');
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ wordId: 'w1', entryId: 'en-yo-noun-MOVED' });
    });
  });

  it('proposes nothing for a disappeared etymology, and still shows what was pinned', async () => {
    mockFetch([READY], undefined, {
      items: [
        {
          wordId: 'w1',
          displayText: 'ikun',
          citedEntryId: 'en-yo-noun-VANISHED',
          kind: 'disappeared',
          pin: pin(['a meaning nothing else carries']),
        },
      ],
      counts: { unchanged: 0, content_changed: 0, re_identified: 0, disappeared: 1 },
      exempt: 0,
      uncited: 0,
    });
    render(<ReviewQueue onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('An etymology we cite is gone')).toBeInTheDocument());
    expect(screen.getByLabelText('Upstream change for ikun')).toHaveTextContent('a meaning nothing else carries');
    expect(screen.queryByRole('button', { name: /Re-link/ })).not.toBeInTheDocument();
  });

  it('does not take the work queue down when the drift check fails', async () => {
    // Drift is a background health check. The consensus queue is the actual work.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/upstream-drift')) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ groups: [READY] }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ReviewQueue onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Ready to confirm')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ReviewQueue', () => {
  it('buckets groups into the four sections', async () => {
    mockFetch([READY, CONTESTED, SINGLE, DISSENT]);
    render(<ReviewQueue onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Conflicts')).toBeInTheDocument());
    expect(within(screen.getByLabelText('Conflicts')).getByText('display_con1')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Ready to confirm')).getByText('display_ready1')).toBeInTheDocument();
    expect(within(screen.getByLabelText('One vote only')).getByText('display_sing1')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Disputed after being settled')).getByText('display_dis1')).toBeInTheDocument();
  });

  it('omits a section entirely when it has nothing in it', async () => {
    mockFetch([READY]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Ready to confirm')).toBeInTheDocument());
    expect(screen.queryByLabelText('Conflicts')).not.toBeInTheDocument();
  });

  it('reports how much needs attention', async () => {
    mockFetch([READY, CONTESTED]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Review queue size')).toHaveTextContent('2 words need'));
  });

  it('says so when nothing is waiting', async () => {
    mockFetch([]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing waiting on you/)).toBeInTheDocument());
  });

  it('shows every competing claim with its vote count and voters', async () => {
    mockFetch([CONTESTED]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => screen.getByLabelText('Claims for display_con1'));

    const claims = screen.getByLabelText('Claims for display_con1');
    expect(claims).toHaveTextContent('2 votes');
    expect(claims).toHaveTextContent('1 vote');
    expect(claims).toHaveTextContent('ada, ben');
    expect(claims).toHaveTextContent('cy');
    // Both assertions are visible side by side - that is the point of the screen.
    expect(claims).toHaveTextContent('stomach');
    expect(claims).toHaveTextContent('belly');
  });

  describe('bulk confirm', () => {
    it('is disabled until something is selected', async () => {
      mockFetch([READY]);
      render(<ReviewQueue onOpenWord={() => {}} />);
      await waitFor(() => screen.getByRole('button', { name: /Confirm/ }));
      expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled();
    });

    it('confirms the selected words in ONE request, each with its expected fingerprint', async () => {
      const second = group('ready2', 'ready', [claim('fp-c', 3, ['ada', 'ben', 'cy'])]);
      const fetchMock = mockFetch([READY, second]);
      const user = userEvent.setup();
      render(<ReviewQueue onOpenWord={() => {}} />);
      await waitFor(() => screen.getByRole('button', { name: 'Select all' }));

      await user.click(screen.getByRole('button', { name: 'Select all' }));
      await user.click(screen.getByRole('button', { name: /Confirm 2 selected/ }));

      const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0][0]).toBe('/api/consensus/confirm');
      const body = JSON.parse((posts[0][1] as RequestInit).body as string);
      expect(body.items).toEqual([
        { wordId: 'ready1', axis: 'entry', expectedFingerprint: 'fp-a' },
        { wordId: 'ready2', axis: 'entry', expectedFingerprint: 'fp-c' },
      ]);
    });

    it('selects and clears individual rows', async () => {
      mockFetch([READY]);
      const user = userEvent.setup();
      render(<ReviewQueue onOpenWord={() => {}} />);
      await waitFor(() => screen.getByLabelText('Select display_ready1'));

      await user.click(screen.getByLabelText('Select display_ready1'));
      expect(screen.getByRole('button', { name: /Confirm 1 selected/ })).toBeEnabled();
      await user.click(screen.getByLabelText('Select display_ready1'));
      expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled();
    });

    it('reports partial success, naming what was skipped and why', async () => {
      // Partial success is the designed behaviour - one word gaining a
      // dissenting vote must not discard the rest of the batch.
      mockFetch([READY], {
        confirmed: [{ wordId: 'ready1', axis: 'entry', fingerprint: 'fp-a', agreementCount: 2 }],
        skipped: [{ wordId: 'other', axis: 'entry', reason: 'changed_since_you_looked' }],
      });
      const user = userEvent.setup();
      render(<ReviewQueue onOpenWord={() => {}} />);
      await waitFor(() => screen.getByLabelText('Select display_ready1'));

      await user.click(screen.getByLabelText('Select display_ready1'));
      await user.click(screen.getByRole('button', { name: /Confirm 1 selected/ }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirmed 1'));
      expect(screen.getByRole('status')).toHaveTextContent(/Skipped 1/);
      expect(screen.getByRole('status')).toHaveTextContent(/changed since you looked/);
    });
  });

  describe('resolving a conflict', () => {
    it('offers a one-click choice per claim and posts the chosen fingerprint', async () => {
      const fetchMock = mockFetch([CONTESTED]);
      const user = userEvent.setup();
      render(<ReviewQueue onOpenWord={() => {}} />);
      await waitFor(() => screen.getByLabelText('Claims for display_con1'));

      // Two claims, so two "Use this" buttons; take the minority one.
      const buttons = screen.getAllByRole('button', { name: 'Use this' });
      expect(buttons).toHaveLength(2);
      await user.click(buttons[1]);

      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.items).toEqual([{ wordId: 'con1', axis: 'entry', expectedFingerprint: 'fp-b' }]);
    });

    it('does NOT offer per-claim choice in the ready section - that is the bulk path', async () => {
      mockFetch([READY]);
      render(<ReviewQueue onOpenWord={() => {}} />);
      await waitFor(() => screen.getByLabelText('Claims for display_ready1'));
      expect(screen.queryByRole('button', { name: 'Use this' })).not.toBeInTheDocument();
    });

    it('lets a curator open the word instead of picking someone else\'s answer', async () => {
      mockFetch([CONTESTED]);
      const onOpenWord = vi.fn();
      const user = userEvent.setup();
      render(<ReviewQueue onOpenWord={onOpenWord} />);
      await waitFor(() => screen.getByRole('button', { name: 'display_con1' }));

      await user.click(screen.getByRole('button', { name: 'display_con1' }));
      expect(onOpenWord).toHaveBeenCalledWith('con1', 'entry');
    });
  });

  it('explains that a disputed decision still stands', async () => {
    mockFetch([DISSENT]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => screen.getByLabelText('Disputed after being settled'));
    expect(screen.getByText(/Settled by curator@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/still stands until you act/)).toBeInTheDocument();
  });

  it('renders an etymology claim as components rather than a spelling', async () => {
    const etym: ConsensusGroup = {
      ...group('etym1', 'ready', []),
      axis: 'etymology',
      summary: {
        ...group('etym1', 'ready', []).summary,
        tally: [
          {
            fingerprint: 'fp-e',
            outcome: { kind: 'etymology', components: ['comp_a', 'comp_b'], atomic: false },
            count: 2,
            voters: ['ada', 'ben'],
            voterLabels: ['ada', 'ben'],
            earliestSubmittedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        winner: {
          fingerprint: 'fp-e',
          outcome: { kind: 'etymology', components: ['comp_a', 'comp_b'], atomic: false },
          count: 2,
          voters: ['ada', 'ben'],
          voterLabels: ['ada', 'ben'],
          earliestSubmittedAt: '2026-08-01T00:00:00.000Z',
        },
      },
    };
    mockFetch([etym]);
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => screen.getByLabelText('Claims for display_etym1'));
    expect(screen.getByLabelText('Claims for display_etym1')).toHaveTextContent('comp_a + comp_b');
  });

  it('shows an error banner when the queue cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'curator role required' }) }));
    render(<ReviewQueue onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('curator role required'));
  });
});

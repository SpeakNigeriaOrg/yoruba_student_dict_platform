// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { RecentWordsBrowser, groupByDay } from './RecentWordsBrowser.js';
import type { RecentWordSummary } from '../api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function word(wordId: string, createdAt: Date, alreadyAssigned = false): RecentWordSummary {
  return {
    wordId,
    displayText: wordId,
    definition: null,
    entryType: null,
    createdAt: createdAt.toISOString(),
    alreadyAssigned,
  };
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

function daysAgoNoon(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
}

function stubRecentWords(words: RecentWordSummary[]) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('groupByDay', () => {
  it('groups consecutive words by local calendar day and labels the two most recent relatively', () => {
    const groups = groupByDay(
      [word('a', daysAgoNoon(0)), word('b', daysAgoNoon(0)), word('c', daysAgoNoon(1)), word('d', daysAgoNoon(5))],
      new Date(),
    );
    expect(groups.slice(0, 2).map((g) => g.label)).toEqual(['Today', 'Yesterday']);
    // Anything older is named outright rather than counted back to.
    expect(groups[2].label).toBe(daysAgoNoon(5).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
    expect(groups.map((g) => g.words.length)).toEqual([2, 1, 1]);
  });

  it('keys by the local day, not the UTC one', () => {
    // A word added at 23:30 local belongs to the day the curator remembers
    // adding it on, whichever UTC date that instant falls in.
    const late = new Date();
    late.setHours(23, 30, 0, 0);
    const groups = groupByDay([word('late', late)], late);
    expect(groups[0].label).toBe('Today');
  });
});

describe('RecentWordsBrowser', () => {
  it('asks the API for the target user and renders the words grouped by day', async () => {
    const fetchMock = stubRecentWords([word('new1', hoursAgo(1)), word('old1', daysAgoNoon(4))]);

    render(<RecentWordsBrowser userId="u1" onAddSelected={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/new1/)).toBeInTheDocument());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/recent-words?userId=u1');
    expect(screen.getByRole('list', { name: 'Words added Today' })).toBeInTheDocument();
    expect(screen.getByText(/old1/)).toBeInTheDocument();
  });

  it("pre-selects the newest day's unassigned words and nothing older", async () => {
    stubRecentWords([word('new1', hoursAgo(1)), word('new2', hoursAgo(2)), word('old1', daysAgoNoon(4))]);

    render(<RecentWordsBrowser userId="u1" onAddSelected={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Add 2 selected/ })).toBeInTheDocument());
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
  });

  it('shows already-assigned words but never selects or lets you select them', async () => {
    stubRecentWords([word('mine', hoursAgo(1), true), word('new1', hoursAgo(2))]);

    render(<RecentWordsBrowser userId="u1" onAddSelected={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/already assigned/)).toBeInTheDocument());
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[0].checked).toBe(false);
    expect(screen.getByRole('button', { name: /Add 1 selected/ })).toBeInTheDocument();
  });

  it("a day's select-all covers only that day, and toggles back to a clear", async () => {
    stubRecentWords([word('new1', hoursAgo(1)), word('old1', daysAgoNoon(4)), word('old2', daysAgoNoon(4))]);
    const user = userEvent.setup();

    render(<RecentWordsBrowser userId="u1" onAddSelected={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Add 1 selected/ })).toBeInTheDocument());

    const olderDay = daysAgoNoon(4).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    await user.click(screen.getByRole('button', { name: `Select all 2 from ${olderDay}` }));
    expect(screen.getByRole('button', { name: /Add 3 selected/ })).toBeInTheDocument();

    // Today's own Clear is present too - the one clicked must be the day whose
    // words were just selected, which is what makes this a per-day control.
    await user.click(screen.getByRole('button', { name: `Clear ${olderDay}` }));
    expect(screen.getByRole('button', { name: /Add 1 selected/ })).toBeInTheDocument();
  });

  it('hands the checked word_ids back newest-first and closes', async () => {
    stubRecentWords([word('new1', hoursAgo(1)), word('new2', hoursAgo(2)), word('old1', daysAgoNoon(4))]);
    const onAddSelected = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<RecentWordsBrowser userId="u1" onAddSelected={onAddSelected} onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Add 2 selected/ })).toBeInTheDocument());

    const olderDay = daysAgoNoon(4).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    await user.click(screen.getByRole('button', { name: `Select all 1 from ${olderDay}` }));
    await user.click(screen.getByRole('button', { name: /Add 3 selected/ }));

    expect(onAddSelected).toHaveBeenCalledWith(['new1', 'new2', 'old1']);
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a load failure instead of sitting on "Loading"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }));

    render(<RecentWordsBrowser userId="u1" onAddSelected={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load recently added words/));
    expect(screen.queryByText('Loading recently added words...')).not.toBeInTheDocument();
  });

  it('says so when nothing has been added yet', async () => {
    stubRecentWords([]);

    render(<RecentWordsBrowser userId="u1" onAddSelected={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('No words have been added yet.')).toBeInTheDocument());
  });
});

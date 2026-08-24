// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TaskQueue } from './TaskQueue.js';
import entryFixture from '../fixtures/entryReview.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Skips live in sessionStorage (app/src/skippedTasks.ts) so they survive the queue
  // unmounting to open a word. That also means they survive between tests unless cleared.
  window.sessionStorage.clear();
});

interface AxisFlags {
  entry?: boolean;
  etymology?: boolean;
  audio?: boolean;
  example?: boolean;
}

function assignment(wordId: string, flags: AxisFlags = {}) {
  return {
    wordId,
    displayText: `display_${wordId}`,
    syllables: [wordId],
    definition: `def_${wordId}`,
    entryType: null,
    assignedAt: '2026-08-01T00:00:00.000Z',
    axisDecided: { entry: false, etymology: false, audio: false, example: false, ...flags },
  };
}

/** Serves a mutable assignments list so a test can simulate the server state
 * changing after a submit, which is what the queue advances on. */
function installFetchMock(getAssignments: () => unknown[]) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    // GET /api/assignments/me returns a bare array, not a wrapper object.
    if (url.includes('/assignments/me')) {
      return Promise.resolve({ ok: true, json: async () => getAssignments() });
    }
    if (url.includes('/axis-status')) {
      return Promise.resolve({ ok: true, json: async () => ({ entry: false, etymology: false, audio: false, example: false }) });
    }
    if (url.includes('/etymology')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          wordId: 'w1',
          displayText: 'display_w1',
          syllables: ['w1'],
          definition: null,
          axisDecided: { entry: true, etymology: false, audio: false, example: false },
          etymologyText: null,
          components: [],
          componentsProposal: [],
          usedInProposal: [],
          usedAsComponentOf: [],
          componentsStatus: 'proposed',
        }),
      });
    }
    if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
    if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('TaskQueue', () => {
  it('hands over the first pending task with honest progress', async () => {
    installFetchMock(() => [assignment('w1'), assignment('w2')]);

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    // Two words x three axes, none done.
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 1 of 8');
    expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument();
    // The review screen has its own fetch, so it lands after the queue header.
    await waitFor(() => expect(screen.getByLabelText('Entry review')).toBeInTheDocument());
  });

  it('counts already-done axes toward progress', async () => {
    installFetchMock(() => [assignment('w1', { entry: true, etymology: true })]);

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    // Four axes per word; two are done, so this is task 3 of 4.
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 3 of 4');
    // Audio comes before example, so that is what it hands over.
    expect(screen.getByText('Record this word')).toBeInTheDocument();
  });

  it('shows an all-caught-up state instead of a task when nothing is pending', async () => {
    installFetchMock(() => [assignment('w1', { entry: true, etymology: true, audio: true, example: true })]);

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByText('All caught up')).toBeInTheDocument());
    expect(screen.queryByLabelText('Queue progress')).not.toBeInTheDocument();
  });

  it('shows the no-assignments state separately from all-caught-up', async () => {
    installFetchMock(() => []);

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByText('No words assigned to you right now.')).toBeInTheDocument());
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
  });

  it('advances to the next axis of the SAME word after a submit', async () => {
    // Finishing a word's entry axis should move to its etymology, not jump to
    // an unrelated word.
    let state = [assignment('w1'), assignment('w2')];
    installFetchMock(() => state);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={true} onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Entry review')).toBeInTheDocument());

    // Simulate the entry decision landing server-side, then submit.
    state = [assignment('w1', { entry: true }), assignment('w2')];
    // No spelling click needed: the tone row arrives pre-filled, so leaving it alone
    // IS the answer (keep_ours). Confirm is enabled from the start.
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(screen.getByText('Check the word parts')).toBeInTheDocument());
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 2 of 8');
  });

  it('skip hands over a DIFFERENT task, and still submits nothing', async () => {
    // This test used to assert only the second half, and that is how the bug shipped: Skip
    // was wired to the post-submit advance(), which re-derives the next task from server
    // state a skip does not change, so the identical task came straight back. Worse, the
    // click set currentWordId and nextTask PREFERS that word, so the one control for
    // getting past a task pinned you to it. A button with an empty onClick passed the old
    // assertions unchanged - which is why the "moves on" half is now asserted first.
    const state = [assignment('w1'), assignment('w2')];
    const fetchMock = installFetchMock(() => state);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={true} onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    await waitFor(() => expect(screen.getByText('Check the word parts')).toBeInTheDocument());
    // Moved PAST, not finished: the position advances while the completion bar does not.
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 2 of 8');
    expect(screen.getByLabelText('Skipped tasks')).toHaveTextContent('1 set aside for now.');

    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('skips its way off a word and on to the next one', async () => {
    const fetchMock = installFetchMock(() => [assignment('w1', { etymology: true, audio: true }), assignment('w2')]);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={true} onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Skip for now' })); // w1 entry
    await waitFor(() => expect(screen.getByText('Show the word in use')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Skip for now' })); // w1 example

    // Back to an entry task - w2's, not the w1 one that was set aside. Asserted on the
    // word the screen FETCHED rather than what it renders: every review screen in this
    // file is served the same fixture regardless of word_id, so its text says nothing
    // about which word the queue chose.
    await waitFor(() => expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/words/w2/entry'))).toBe(true);
    expect(screen.getByLabelText('Skipped tasks')).toHaveTextContent('2 set aside for now.');
  });

  it('says so when everything left is set aside, and can bring it all back', async () => {
    installFetchMock(() => [assignment('w1', { etymology: true, audio: true, example: true })]);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={true} onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    // Not "All caught up" - that would claim work is finished when it is only postponed.
    await waitFor(() => expect(screen.getByText('Nothing left but what you set aside')).toBeInTheDocument());
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Bring back skipped tasks' }));
    await waitFor(() => expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument());
  });

  it('keeps a task set aside across a later submit', async () => {
    // advance() re-reads the server; the skip set is client-side and must survive that,
    // or finishing any other task quietly re-serves what was skipped.
    const done = { etymology: true, audio: true, example: true };
    let state = [assignment('w1', done), assignment('w2', done)];
    installFetchMock(() => state);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={true} onOpenWord={() => {}} />);
    await waitFor(() => expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Skip for now' })); // w1 entry
    await waitFor(() => expect(screen.getByLabelText('Skipped tasks')).toHaveTextContent('1 set aside'));

    state = [assignment('w1', done), assignment('w2', { ...done, entry: true })];
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    // w1's entry is still pending server-side, and the refetch re-read it - but it stays
    // set aside rather than being handed straight back.
    await waitFor(() => expect(screen.getByText('Nothing left but what you set aside')).toBeInTheDocument());
  });

  it('can still show the whole list as an escape hatch', async () => {
    installFetchMock(() => [assignment('w1'), assignment('w2')]);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: 'My whole list' }));

    await user.click(screen.getByRole('button', { name: 'My whole list' }));

    const list = screen.getByLabelText('My assignments');
    expect(list).toHaveTextContent('display_w1');
    expect(list).toHaveTextContent('display_w2');
  });

  it('opens a word properly when a list row is picked, so it is deep-linkable', async () => {
    installFetchMock(() => [assignment('w1')]);
    const onOpenWord = vi.fn();
    const user = userEvent.setup();

    render(<TaskQueue isCurator={false} onOpenWord={onOpenWord} />);
    await waitFor(() => screen.getByRole('button', { name: 'My whole list' }));
    await user.click(screen.getByRole('button', { name: 'My whole list' }));
    await user.click(screen.getByRole('button', { name: 'display_w1' }));

    expect(onOpenWord).toHaveBeenCalledWith('w1', 'entry');
  });

  it('shows an error banner when assignments cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    );

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load your tasks/));
  });
});

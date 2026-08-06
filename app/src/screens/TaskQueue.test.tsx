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
});

interface AxisFlags {
  entry?: boolean;
  etymology?: boolean;
  audio?: boolean;
}

function assignment(wordId: string, flags: AxisFlags = {}) {
  return {
    wordId,
    displayText: `display_${wordId}`,
    syllables: [wordId],
    definition: `def_${wordId}`,
    entryType: null,
    assignedAt: '2026-08-01T00:00:00.000Z',
    axisDecided: { entry: false, etymology: false, audio: false, ...flags },
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
      return Promise.resolve({ ok: true, json: async () => ({ entry: false, etymology: false, audio: false }) });
    }
    if (url.includes('/etymology')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          wordId: 'w1',
          displayText: 'display_w1',
          syllables: ['w1'],
          definition: null,
          axisDecided: { entry: true, etymology: false, audio: false },
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
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 1 of 6');
    expect(screen.getByText('Confirm the spelling and meaning')).toBeInTheDocument();
    // The review screen has its own fetch, so it lands after the queue header.
    await waitFor(() => expect(screen.getByLabelText('Entry review')).toBeInTheDocument());
  });

  it('counts already-done axes toward progress', async () => {
    installFetchMock(() => [assignment('w1', { entry: true, etymology: true })]);

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 3 of 3');
    // Only audio is left, so that is what it hands over.
    expect(screen.getByText('Record this word')).toBeInTheDocument();
  });

  it('shows an all-caught-up state instead of a task when nothing is pending', async () => {
    installFetchMock(() => [assignment('w1', { entry: true, etymology: true, audio: true })]);

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
    await user.click(screen.getByRole('button', { name: /that's right/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(screen.getByText('Check the word parts')).toBeInTheDocument());
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent('Task 2 of 6');
  });

  it('skip moves on without submitting anything', async () => {
    const state = [assignment('w1'), assignment('w2')];
    const fetchMock = installFetchMock(() => state);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={true} onOpenWord={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: 'Skip for now' }));

    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    // No decision or contribution was posted.
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('can still show the whole list as an escape hatch', async () => {
    installFetchMock(() => [assignment('w1'), assignment('w2')]);
    const user = userEvent.setup();

    render(<TaskQueue isCurator={false} onOpenWord={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: 'Show my whole list' }));

    await user.click(screen.getByRole('button', { name: 'Show my whole list' }));

    const list = screen.getByLabelText('My assignments');
    expect(list).toHaveTextContent('display_w1');
    expect(list).toHaveTextContent('display_w2');
  });

  it('opens a word properly when a list row is picked, so it is deep-linkable', async () => {
    installFetchMock(() => [assignment('w1')]);
    const onOpenWord = vi.fn();
    const user = userEvent.setup();

    render(<TaskQueue isCurator={false} onOpenWord={onOpenWord} />);
    await waitFor(() => screen.getByRole('button', { name: 'Show my whole list' }));
    await user.click(screen.getByRole('button', { name: 'Show my whole list' }));
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

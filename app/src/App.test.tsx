// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App.js';
import assignmentsFixture from './fixtures/assignments.json';
import entryFixture from './fixtures/entryReview.json';
import etymologyFixture from './fixtures/etymologyReview.json';

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const AXIS_STATUS = { entry: true, etymology: false, audio: true, example: false };

function installFetchMock(roles: string[] = ['authenticated']) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.includes('/.auth/me')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            clientPrincipal: { identityProvider: 'google', userId: 'u1', userDetails: 'tester@example.com', userRoles: roles },
          }),
        });
      }
      if (url.includes('/assignments/me')) return Promise.resolve({ ok: true, json: async () => assignmentsFixture });
      if (url.includes('/axis-status')) return Promise.resolve({ ok: true, json: async () => AXIS_STATUS });
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      // A real payload, not the {} fallback. Returning {} left EtymologyReview
      // reading `review.components.length` off an object that had no components
      // and throwing, which vitest reported as an unhandled error while the
      // routing assertions here still passed - the tab it checks is rendered by
      // App, not by the screen that crashed.
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => etymologyFixture });
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

describe('App', () => {
  it('lands a volunteer straight on a task rather than a list to navigate', async () => {
    installFetchMock();
    render(<App />);

    // The queue hands over the head task itself - the review form is on screen
    // with no intervening list click, and deliberately WITHOUT axis tabs: the
    // queue chose the task, so tabs would only invite navigating away from it.
    await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent(/Task \d+ of \d+/);
    await waitFor(() => expect(screen.getByLabelText('Entry review')).toBeInTheDocument());
  });

  it('shows no axis tabs in the queue - the queue already chose the task', async () => {
    installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    expect(screen.queryByLabelText('Review axis tabs')).not.toBeInTheDocument();
  });

  it('colors each axis tab by its fetched status when browsing a word directly', async () => {
    // Tabs belong on the browse route, where you arrived at a WORD rather than
    // being handed a task, and moving between its axes is the point.
    installFetchMock();
    window.location.hash = '#/word/some_word/entry';
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entry' })).toHaveClass('axis-complete');
    });
    expect(screen.getByRole('button', { name: 'Etymology' })).toHaveClass('axis-pending');
    expect(screen.getByRole('button', { name: 'Audio' })).toHaveClass('axis-complete');
    // Four axes now: the example is the fourth and last.
    expect(screen.getByRole('button', { name: 'Example' })).toHaveClass('axis-pending');
  });

  it('renders all four axis tabs, so none is unreachable', async () => {
    installFetchMock();
    window.location.hash = '#/word/some_word/entry';
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Review axis tabs')).toBeInTheDocument());
    for (const label of ['Entry', 'Etymology', 'Audio', 'Example']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  describe('routing', () => {
    it('deep-links straight to a word and axis from the hash', async () => {
      installFetchMock();
      window.location.hash = '#/word/some_word/etymology';

      render(<App />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Etymology' })).toHaveAttribute('aria-current', 'page');
      });
      // The word screen, not the queue.
      expect(screen.queryByLabelText('Queue progress')).not.toBeInTheDocument();
    });

    it('deciding an axis on the word route moves to the next unfinished one', async () => {
      // AXIS_STATUS is { entry: true, etymology: false, audio: true }, so confirming the
      // entry axis should land on etymology. Before this, confirming here left you on the
      // axis you had just finished with the tab bar as the only way forward.
      installFetchMock();
      const user = userEvent.setup();
      window.location.hash = '#/word/some_word/entry';

      render(<App />);
      await waitFor(() => expect(screen.getByLabelText('Tone editor')).toBeInTheDocument());
      // 'Confirm', not 'Confirm entry': this mock is a volunteer, who proposes rather
      // than decides. Their submission is a contribution, which axisDecided counts as
      // their own answer - so the advance works on both paths.
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => expect(window.location.hash).toBe('#/word/some_word/etymology'));
    });

    it('normalises an empty hash so there is always a history entry to go back to', async () => {
      installFetchMock();
      render(<App />);
      await waitFor(() => expect(window.location.hash).toBe('#/queue'));
    });

    it('switching axis updates the hash, making the current screen shareable and refresh-safe', async () => {
      installFetchMock();
      const user = userEvent.setup();
      window.location.hash = '#/word/some_word/entry';

      render(<App />);
      await waitFor(() => screen.getByRole('button', { name: 'Audio' }));
      await user.click(screen.getByRole('button', { name: 'Audio' }));

      await waitFor(() => expect(window.location.hash).toBe('#/word/some_word/audio'));
    });

    it('falls back to the queue for a hash left over from the pre-merge axes', async () => {
      installFetchMock();
      window.location.hash = '#/spelling';

      render(<App />);
      await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    });

    it('gives curators the bottom nav on review screens too, not just on lists', async () => {
      // It used to be hidden whenever a word was open, which removed the only
      // escape from the longest screens in the app.
      installFetchMock(['authenticated', 'curator']);
      window.location.hash = '#/word/some_word/entry';

      render(<App />);
      await waitFor(() => expect(screen.getByLabelText('Main navigation')).toBeInTheDocument());
    });

    it('does not give volunteers the curator bottom nav', async () => {
      installFetchMock(['authenticated']);
      render(<App />);
      await waitFor(() => screen.getByLabelText('Queue progress'));
      expect(screen.queryByLabelText('Main navigation')).not.toBeInTheDocument();
    });
  });
});

describe('App - the contributor agreement is asked once', () => {
  /** Same shape as installFetchMock, plus a real /grants/me answer and a spy on the POST
   * so the recorded answer can be inspected. The default mock returns {} for that route,
   * which is why every other test in this file opens straight into the app: an
   * unanswerable response never interrupts. */
  function installGrantMock(needsAcceptance: boolean) {
    const post = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/.auth/me')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              clientPrincipal: {
                identityProvider: 'google',
                userId: 'u1',
                userDetails: 'tester@example.com',
                userRoles: ['authenticated'],
              },
            }),
          });
        }
        if (url.includes('/grants/me')) {
          if (init?.method === 'POST') {
            post(JSON.parse(String(init.body)));
            return Promise.resolve({
              ok: true,
              json: async () => ({ releaseState: 'open_permitted', needsAcceptance: false }),
            });
          }
          return Promise.resolve({ ok: true, json: async () => ({ releaseState: 'unknown', needsAcceptance }) });
        }
        if (url.includes('/assignments/me')) return Promise.resolve({ ok: true, json: async () => assignmentsFixture });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );
    return post;
  }

  it('interrupts an account that has never answered', async () => {
    installGrantMock(true);
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Contributor agreement')).toBeInTheDocument());
    // And the work behind it is genuinely not shown yet.
    expect(screen.queryByLabelText('Queue progress')).not.toBeInTheDocument();
  });

  it('does not interrupt an account that has already answered', async () => {
    installGrantMock(false);
    render(<App />);
    await waitFor(() => screen.getByLabelText('Queue progress'));
    expect(screen.queryByLabelText('Contributor agreement')).not.toBeInTheDocument();
  });

  it('agreeing records the answer and opens the app', async () => {
    const post = installGrantMock(true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByLabelText('Contributor agreement'));

    await user.click(screen.getByRole('button', { name: 'I agree' }));

    await waitFor(() => screen.getByLabelText('Queue progress'));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ openReleasePermitted: true, attributionMode: 'real_name' }),
    );
  });

  it('declining also opens the app - it is an answer, not a refusal to work', async () => {
    // The property that makes this consent rather than coercion. A contributor who says
    // no keeps working exactly as before; only external publication is affected.
    const post = installGrantMock(true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByLabelText('Contributor agreement'));

    await user.click(screen.getByRole('button', { name: 'I do not agree' }));
    await user.click(screen.getByRole('button', { name: /Confirm/ }));

    await waitFor(() => screen.getByLabelText('Queue progress'));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ declineReason: expect.any(String) }));
  });

  it('lets someone accept the rest while refusing open release', async () => {
    // The terms promise this half can be answered separately, so it has to be reachable
    // without declining everything.
    const post = installGrantMock(true);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => screen.getByLabelText('Contributor agreement'));

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'I agree' }));

    await waitFor(() => screen.getByLabelText('Queue progress'));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ openReleasePermitted: false }));
  });
});

describe('App - a declined account cannot contribute', () => {
  function installDeclinedMock() {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/.auth/me')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              clientPrincipal: {
                identityProvider: 'google',
                userId: 'u1',
                userDetails: 'tester@example.com',
                userRoles: ['authenticated'],
              },
            }),
          });
        }
        if (url.includes('/grants/me')) {
          // The shape a declined account gets back: it HAS answered the current wording, so
          // needsAcceptance is false - what puts the screen back is canContribute.
          return Promise.resolve({
            ok: true,
            json: async () => ({ releaseState: 'declined', needsAcceptance: false, canContribute: false }),
          });
        }
        if (url.includes('/assignments/me')) return Promise.resolve({ ok: true, json: async () => assignmentsFixture });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );
  }

  it('shows the agreement again rather than a queue of work it cannot save', async () => {
    // Every write endpoint refuses this account, so a task list would be a list of things
    // that fail on submit - and finding that out at the end of a recording is the worst
    // possible moment to find it out.
    installDeclinedMock();
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Contributions paused')).toBeInTheDocument());
    expect(screen.queryByLabelText('Queue progress')).not.toBeInTheDocument();
  });

  it('offers the way back, and says the earlier work is kept', async () => {
    installDeclinedMock();
    render(<App />);
    await waitFor(() => screen.getByLabelText('Contributions paused'));
    expect(screen.getByRole('button', { name: 'I agree' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contributions paused')).toHaveTextContent('still here');
  });
});

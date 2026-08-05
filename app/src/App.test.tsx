// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App.js';
import assignmentsFixture from './fixtures/assignments.json';
import entryFixture from './fixtures/entryReview.json';

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const AXIS_STATUS = { entry: true, etymology: false, audio: true };

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
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

describe('App', () => {
  it('lands a volunteer straight on a task rather than a list to navigate', async () => {
    installFetchMock();
    render(<App />);

    // The queue hands over the head task itself - the axis tabs and the
    // review form are on screen with no intervening list click.
    await waitFor(() => expect(screen.getByLabelText('Queue progress')).toBeInTheDocument());
    expect(screen.getByLabelText('Queue progress')).toHaveTextContent(/Task \d+ of \d+/);
    await waitFor(() => expect(screen.getByLabelText('Entry review')).toBeInTheDocument());
  });

  it('colors each axis tab by its fetched status', async () => {
    installFetchMock();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entry' })).toHaveClass('axis-complete');
    });
    expect(screen.getByRole('button', { name: 'Etymology' })).toHaveClass('axis-pending');
    expect(screen.getByRole('button', { name: 'Audio' })).toHaveClass('axis-complete');
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

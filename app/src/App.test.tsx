// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App.js';
import assignmentsFixture from './fixtures/assignments.json';
import spellingFixture from './fixtures/spellingReview.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const AXIS_STATUS = { spelling: false, definition: true, etymology: false, audio: true };

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.includes('/.auth/me')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            clientPrincipal: { identityProvider: 'github', userId: 'u1', userDetails: 'tester', userRoles: ['authenticated'] },
          }),
        });
      }
      if (url.includes('/assignments/me')) return Promise.resolve({ ok: true, json: async () => assignmentsFixture });
      if (url.includes('/axis-status')) return Promise.resolve({ ok: true, json: async () => AXIS_STATUS });
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

describe('App axis tab status coloring', () => {
  it('colors each axis tab by its fetched status once a word is selected', async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await waitFor(() => screen.getByText('fixturegencompoundspelling'));
    await user.click(screen.getByText('fixturegencompoundspelling'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Definition' })).toHaveClass('axis-complete');
    });
    expect(screen.getByRole('button', { name: 'Spelling' })).toHaveClass('axis-pending');
    expect(screen.getByRole('button', { name: 'Etymology' })).toHaveClass('axis-pending');
    expect(screen.getByRole('button', { name: 'Audio' })).toHaveClass('axis-complete');
  });
});

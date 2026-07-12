// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SpellingReview } from './SpellingReview.js';
import spellingFixture from '../fixtures/spellingReview.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SpellingReview', () => {
  it('renders a real tone-mismatch diagnosis (fixture generated via the real getSpellingReview handler against real Postgres)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => spellingFixture }));

    render(<SpellingReview wordId="fixturegenspldef_spellingword" />);

    await waitFor(() => {
      expect(screen.getByText('fixturegenspldef_kasu')).toBeInTheDocument();
    });

    const diagnosis = screen.getByLabelText('Spelling diagnosis');
    expect(diagnosis).toHaveTextContent('tone_mismatch');
    expect(diagnosis).toHaveTextContent('fixturegenspldef_kásù');

    const axisStatus = screen.getByLabelText('Review axis status');
    expect(axisStatus).toHaveTextContent('Spelling (not yet decided)');
  });

  it('submits adopt_kaikki with the diagnosed adoptionTarget as newDisplayText', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<SpellingReview wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await user.click(screen.getByRole('button', { name: "Adopt Kaikki's spelling" }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent("Adopted Kaikki's spelling: fixturegenspldef_kásù");
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/spelling');
    expect(decisionCall).toBeDefined();
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegenspldef_spellingword',
      action: 'adopt_kaikki',
      newDisplayText: 'fixturegenspldef_kásù',
    });
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'word not found' }) }),
    );

    render(<SpellingReview wordId="nonexistent" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('word not found');
    });
  });
});

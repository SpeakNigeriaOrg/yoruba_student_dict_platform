// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EtymologyReview } from './EtymologyReview.js';
import etymologyFixture from '../fixtures/etymologyReview.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EtymologyReview', () => {
  it('renders real componentsProposal and usedInProposal data (fixture generated via the real getEtymologyReview handler against real Postgres)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegencompound_madeupword" />);

    await waitFor(() => {
      expect(screen.getByText('fixturegencompoundspelling')).toBeInTheDocument();
    });

    // Forward: both real proposed components resolve to real word_ids.
    expect(screen.getByText('fixturegenpartonespelling')).toBeInTheDocument();
    expect(screen.getByText(/fixturegenpartone_madeuppart/)).toBeInTheDocument();
    expect(screen.getByText('fixturegenparttwospelling')).toBeInTheDocument();

    // Reverse: the newly-surfaced usedInProposal.
    expect(screen.getByText('fixturegenusedintargetspelling')).toBeInTheDocument();
    expect(screen.getByText(/fixturegenusedintarget_otherword/)).toBeInTheDocument();

    // No confirmed usedAsComponentOf relationships yet in this fixture.
    expect(screen.getByText('No confirmed relationships yet.')).toBeInTheDocument();
  });

  it('submits accept_proposed with the resolved word_ids when both components resolve', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => etymologyFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegencompound_madeupword" />);
    await waitFor(() => screen.getByText('fixturegencompoundspelling'));

    await user.click(screen.getByRole('button', { name: 'Accept proposed components' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Accepted proposed components.');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/etymology');
    expect(decisionCall).toBeDefined();
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegencompound_madeupword',
      componentsAction: 'accept_proposed',
      components: ['fixturegenpartone_madeuppart', 'fixturegenparttwo_madeuppart'],
    });
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'word not found' }) }),
    );

    render(<EtymologyReview wordId="nonexistent" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('word not found');
    });
  });
});

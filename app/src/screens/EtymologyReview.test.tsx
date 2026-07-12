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

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" />);

    await waitFor(() => {
      expect(screen.getByText('fixturegen2_compoundspelling')).toBeInTheDocument();
    });

    // Forward: both real proposed components resolve to real word_ids.
    expect(screen.getByText('fixturegen2_partonespelling')).toBeInTheDocument();
    expect(screen.getByText(/fixturegen2_partone_madeuppart/)).toBeInTheDocument();
    expect(screen.getByText('fixturegen2_parttwospelling')).toBeInTheDocument();

    // Reverse: the newly-surfaced usedInProposal.
    expect(screen.getByText('fixturegen2_usedintargetspelling')).toBeInTheDocument();
    expect(screen.getByText(/fixturegen2_usedintarget_otherword/)).toBeInTheDocument();

    // No confirmed usedAsComponentOf relationships yet in this fixture.
    expect(screen.getByText('No confirmed relationships yet.')).toBeInTheDocument();

    // Read-only spelling/definition context, and the three-axis status banner.
    expect(screen.getByText(/a made-up compound word for fixture generation/)).toBeInTheDocument();
    const axisStatus = screen.getByLabelText('Review axis status');
    expect(axisStatus).toHaveTextContent('Spelling (not yet decided)');
    expect(axisStatus).toHaveTextContent('Definition (decided)');
    expect(axisStatus).toHaveTextContent('Etymology (not yet decided)');
  });

  it('submits accept_proposed with the resolved word_ids when both components resolve', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => etymologyFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    await user.click(screen.getByRole('button', { name: 'Accept proposed components' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Accepted proposed components.');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/etymology');
    expect(decisionCall).toBeDefined();
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegen2_compound_madeupword',
      componentsAction: 'accept_proposed',
      components: ['fixturegen2_partone_madeuppart', 'fixturegen2_parttwo_madeuppart'],
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

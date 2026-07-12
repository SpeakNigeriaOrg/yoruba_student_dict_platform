// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EtymologyReview } from './EtymologyReview.js';
import etymologyFixture from '../fixtures/etymologyReview.json';
import etymologyConfirmedFixture from '../fixtures/etymologyReviewConfirmed.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EtymologyReview', () => {
  it('renders real componentsProposal and usedInProposal data (fixture generated via the real getEtymologyReview handler against real Postgres)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);

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

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
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

    render(<EtymologyReview wordId="nonexistent" isCurator={true} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('word not found');
    });
  });

  it('disables Confirm components for an atomic word and enables Reject when a proposal exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.getByRole('button', { name: 'Confirm components' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject this etymology' })).toBeEnabled();
  });

  it('rejects the proposed etymology', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => etymologyFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    await user.click(screen.getByRole('button', { name: 'Reject this etymology' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Rejected the proposed etymology - stays atomic.');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/etymology');
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({ wordId: 'fixturegen2_compound_madeupword', componentsAction: 'reject_proposed' });
  });

  it('enables Confirm components for a word with real existing components, and submits confirm_existing', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => etymologyConfirmedFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegenconfirmed_compound_word" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegenconfirmed_compoundspelling'));

    const confirmButton = screen.getByRole('button', { name: 'Confirm components' });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Confirmed the existing components.');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/etymology');
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({ wordId: 'fixturegenconfirmed_compound_word', componentsAction: 'confirm_existing' });
  });

  it('pre-seeds the manual draft from real existing components (not a self-referencing atomic chip)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyConfirmedFixture }));

    render(<EtymologyReview wordId="fixturegenconfirmed_compound_word" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegenconfirmed_compoundspelling'));

    const draft = screen.getByLabelText('Draft components');
    expect(draft).toHaveTextContent('fixturegenconfirmed_part_word');
  });

  it('starts with an empty manual draft for an atomic word (no self-referencing chip)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.getByText('No components picked yet.')).toBeInTheDocument();
  });

  it('adding a manual search result and saving submits componentsAction: custom with the draft list', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => etymologyFixture });
      if (url.includes('/vocab-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { wordId: 'manual_component_word', displayText: 'manual spelling', syllables: ['manual'], definition: null, baseSpelling: 'manual', matchedVia: 'yoruba_exact' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('manual_component_word'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const draft = screen.getByLabelText('Draft components');
    expect(draft).toHaveTextContent('manual_component_word');

    await user.click(screen.getByRole('button', { name: 'Save custom components' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Saved custom components: manual_component_word');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/etymology');
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegen2_compound_madeupword',
      componentsAction: 'custom',
      components: ['manual_component_word'],
    });
  });

  it('removing a draft component removes its chip', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyConfirmedFixture }));
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegenconfirmed_compound_word" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegenconfirmed_compoundspelling'));

    expect(screen.getByLabelText('Draft components')).toHaveTextContent('fixturegenconfirmed_part_word');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('No components picked yet.')).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SpellingReview } from './SpellingReview.js';
import spellingFixture from '../fixtures/spellingReview.json';
import spellingAmbiguousFixture from '../fixtures/spellingReviewAmbiguous.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SpellingReview', () => {
  it('renders a real tone-mismatch diagnosis (fixture generated via the real getSpellingReview handler against real Postgres)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => spellingFixture }));

    render(<SpellingReview wordId="fixturegenspldef_spellingword" isCurator={true} />);

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

    render(<SpellingReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
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

    render(<SpellingReview wordId="nonexistent" isCurator={true} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('word not found');
    });
  });

  it('renders ambiguous candidates as radios and a syllable-split mismatch comparison (real fixture)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => spellingAmbiguousFixture }));

    render(<SpellingReview wordId="fixturegenambig_ambigword_somehint" isCurator={true} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'fixturegenambig_ambigspelling' })).toBeInTheDocument();
    });

    const candidates = screen.getByLabelText('Candidates considered');
    expect(candidates).toHaveTextContent('unrelated gloss one');
    expect(candidates).toHaveTextContent('unrelated gloss two');
    expect(screen.getAllByRole('radio')).toHaveLength(2);

    const syllableComparison = screen.getByLabelText('Syllable split comparison');
    expect(syllableComparison).toHaveTextContent('fixturegenambig_ambigspelling');
    expect(syllableComparison).toHaveTextContent('fi · tu · re · ge · na · m · bi · ga · m · bi · gspe · llin · g');
  });

  it('submits select_candidate with the chosen radio candidate', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingAmbiguousFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<SpellingReview wordId="fixturegenambig_ambigword_somehint" isCurator={true} />);
    await waitFor(() => screen.getByRole('heading', { name: 'fixturegenambig_ambigspelling' }));

    const radios = screen.getAllByRole('radio');
    await user.click(radios[1]);
    await user.click(screen.getByRole('button', { name: 'Confirm selected candidate' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Confirmed candidate: fixturegenambig_ambigspelling');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/spelling');
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegenambig_ambigword_somehint',
      action: 'select_candidate',
      candidateForm: 'fixturegenambig_ambigspelling',
    });
  });

  it('refuses to confirm a candidate when none is selected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => spellingAmbiguousFixture }));
    const user = userEvent.setup();

    render(<SpellingReview wordId="fixturegenambig_ambigword_somehint" isCurator={true} />);
    await waitFor(() => screen.getByRole('heading', { name: 'fixturegenambig_ambigspelling' }));

    await user.click(screen.getByRole('button', { name: 'Confirm selected candidate' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Select a candidate first.');
    });
  });

  it('submits accept_programmatic when the programmatic syllable split is accepted', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingAmbiguousFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<SpellingReview wordId="fixturegenambig_ambigword_somehint" isCurator={true} />);
    await waitFor(() => screen.getByRole('heading', { name: 'fixturegenambig_ambigspelling' }));

    await user.click(screen.getByRole('button', { name: 'Accept programmatic split' }));

    await waitFor(() => screen.getByRole('status'));

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/spelling');
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegenambig_ambigword_somehint',
      syllableAction: 'accept_programmatic',
    });
  });

  it('picking a manual Kaikki search result submits select_candidate directly', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      if (url.includes('/kaikki-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { form: 'manualform', pos: 'noun', glosses: ['manual gloss'], matchedVia: 'yoruba_exact', altOfTargets: [], standardForms: ['manualform'] },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<SpellingReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('manualform'));
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Confirmed candidate: manualform');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/spelling');
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegenspldef_spellingword',
      action: 'select_candidate',
      candidateForm: 'manualform',
    });
  });

  it('a non-curator proposes a contribution instead of deciding directly, with a "Propose:" prefixed label and status', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<SpellingReview wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    const button = screen.getByRole('button', { name: "Propose: Adopt Kaikki's spelling" });
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent("Proposed: Adopted Kaikki's spelling: fixturegenspldef_kásù");
    });

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/contributions');
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({
      axis: 'spelling',
      wordId: 'fixturegenspldef_spellingword',
      action: 'adopt_kaikki',
      newDisplayText: 'fixturegenspldef_kásù',
    });
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/spelling')).toBeUndefined();
  });
});

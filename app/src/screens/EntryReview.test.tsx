// @vitest-environment jsdom
//
// Replaces SpellingReview.test.tsx and DefinitionReview.test.tsx. Carries
// over their cases (tone-mismatch diagnosis, adopt_kaikki with the diagnosed
// adoptionTarget, ambiguous candidate radios, syllable-split mismatch,
// manual Kaikki search, proposed-definition rendering, free-typed custom
// text, request-failure and non-curator paths) and adds the ones the merge
// creates: one POST carries both halves, and neither half can be submitted
// alone.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EntryReview } from './EntryReview.js';
import entryFixture from '../fixtures/entryReview.json';
import entryAmbiguousFixture from '../fixtures/entryReviewAmbiguous.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Reads the JSON body of the one POST the screen makes. */
function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
  if (!call) throw new Error('no POST was made');
  return JSON.parse((call[1] as RequestInit).body as string);
}

function mockFetch(fixture: unknown) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => fixture });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('EntryReview', () => {
  it('renders both halves of a real entry diagnosis in one screen', async () => {
    mockFetch(entryFixture);

    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);

    await waitFor(() => {
      expect(screen.getByText('fixturegenspldef_kasu')).toBeInTheDocument();
    });

    // Written form
    const spelling = screen.getByLabelText('Spelling diagnosis');
    expect(spelling).toHaveTextContent('tone_mismatch');
    expect(spelling).toHaveTextContent('fixturegenspldef_kásù');

    // Meaning
    const definition = screen.getByLabelText('Definition diagnosis');
    expect(definition).toHaveTextContent('proposed');
    expect(definition).toHaveTextContent('to fail');

    // One submit button, not five.
    expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeInTheDocument();
  });

  describe('atomicity', () => {
    it('will not submit with no spelling choice armed', async () => {
      const fetchMock = mockFetch(entryFixture);
      const user = userEvent.setup();
      render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
      await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

      // The definition prefills from the proposal, so the only thing missing
      // is the spelling half - and that alone must block submission.
      expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Confirm entry' }));
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
    });

    it('will not submit with an empty definition', async () => {
      const fetchMock = mockFetch(entryFixture);
      const user = userEvent.setup();
      render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
      await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

      await user.click(screen.getByRole('button', { name: /Keep our spelling/ }));
      await user.clear(screen.getByLabelText('Definition text'));

      expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeDisabled();
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
    });

    it('sends spelling and definition in ONE request to /api/decisions/entry', async () => {
      const fetchMock = mockFetch(entryFixture);
      const user = userEvent.setup();
      render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
      await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

      await user.click(screen.getByRole('button', { name: /Keep our spelling/ }));
      await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

      const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0][0]).toBe('/api/decisions/entry');
      const body = postedBody(fetchMock);
      expect(body.action).toBe('keep_ours');
      // The fixture's definitionCurrent is null and the field prefilled from
      // the proposal, so this counts as a custom definition, not a confirm.
      expect(body.definitionAction).toBe('custom');
      expect(body.definitionText).toBe('to fail');
    });
  });

  it('submits adopt_kaikki with the diagnosed adoptionTarget as newDisplayText', async () => {
    const fetchMock = mockFetch(entryFixture);
    const user = userEvent.setup();
    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

    await user.click(screen.getByRole('button', { name: /Adopt Kaikki's spelling/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    const body = postedBody(fetchMock);
    expect(body.action).toBe('adopt_kaikki');
    expect(body.newDisplayText).toBe('fixturegenspldef_kásù');
    expect(body.definitionAction).toBe('custom');
  });

  it('sends definitionAction confirm when the definition text is left as it stands on record', async () => {
    // definitionCurrent non-null and untouched -> 'confirm', not 'custom'.
    const fixture = { ...entryFixture, definitionCurrent: 'to fail', definitionProposed: 'to fail' };
    const fetchMock = mockFetch(fixture);
    const user = userEvent.setup();
    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

    await user.click(screen.getByRole('button', { name: /Keep our spelling/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    const body = postedBody(fetchMock);
    expect(body.definitionAction).toBe('confirm');
    expect(body.definitionText).toBeUndefined();
  });

  it('sends free-typed text as a custom definition', async () => {
    const fixture = { ...entryFixture, definitionCurrent: 'to fail' };
    const fetchMock = mockFetch(fixture);
    const user = userEvent.setup();
    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

    await user.click(screen.getByRole('button', { name: /Keep our spelling/ }));
    await user.clear(screen.getByLabelText('Definition text'));
    await user.type(screen.getByLabelText('Definition text'), 'my own gloss');
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    const body = postedBody(fetchMock);
    expect(body.definitionAction).toBe('custom');
    expect(body.definitionText).toBe('my own gloss');
  });

  describe('ambiguous match', () => {
    it('renders candidate radios and a syllable-split comparison', async () => {
      mockFetch(entryAmbiguousFixture);
      render(<EntryReview wordId="fixturegenambig_ambigword_somehint" isCurator={true} />);
      await waitFor(() => screen.getByLabelText('Candidates considered'));

      const candidates = screen.getByLabelText('Candidates considered');
      expect(candidates).toHaveTextContent('unrelated gloss one');
      expect(candidates).toHaveTextContent('unrelated gloss two');
      expect(screen.getByLabelText('Syllable split comparison')).toBeInTheDocument();
    });

    it('submits select_candidate with the chosen radio, plus the definition half', async () => {
      const fetchMock = mockFetch(entryAmbiguousFixture);
      const user = userEvent.setup();
      render(<EntryReview wordId="fixturegenambig_ambigword_somehint" isCurator={true} />);
      await waitFor(() => screen.getByLabelText('Candidates considered'));

      await user.click(screen.getAllByRole('radio')[1]);
      await user.click(screen.getByRole('button', { name: 'Accept programmatic split' }));
      await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

      await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
      const body = postedBody(fetchMock);
      expect(body.action).toBe('select_candidate');
      expect(body.candidateForm).toBe('fixturegenambig_ambigspelling');
      expect(body.syllableAction).toBe('accept_programmatic');
      expect(body.definitionAction).toBeDefined();
    });
  });

  it('picking a Kaikki search result arms both the spelling candidate and the definition source', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/kaikki-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ results: [{ form: 'searched_form', pos: 'noun', glosses: ['searched gloss'] }] }),
        });
      }
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

    await user.type(screen.getByPlaceholderText('Search Kaikki...'), 'searched');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByLabelText('Kaikki search results'));
    await user.click(screen.getByRole('button', { name: 'Use this record' }));

    // The gloss lands in the definition field...
    expect(screen.getByLabelText('Definition text')).toHaveValue('searched gloss');

    // ...and submitting carries both the candidate and the source form.
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    const body = postedBody(fetchMock);
    expect(body.action).toBe('select_candidate');
    expect(body.candidateForm).toBe('searched_form');
    expect(body.definitionSourceForm).toBe('searched_form');
    expect(body.definitionText).toBe('searched gloss');
  });

  it('a non-curator proposes a contribution instead of deciding directly', async () => {
    const fetchMock = mockFetch(entryFixture);
    const user = userEvent.setup();
    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('Spelling diagnosis'));

    expect(screen.getByRole('button', { name: 'Propose: Confirm entry' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Keep our spelling/ }));
    await user.click(screen.getByRole('button', { name: 'Propose: Confirm entry' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Proposed/));
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts[0][0]).toBe('/api/contributions');
    const body = postedBody(fetchMock);
    expect(body.axis).toBe('entry');
    expect(body.action).toBe('keep_ours');
    expect(body.definitionAction).toBeDefined();
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    );

    render(<EntryReview wordId="fixturegenspldef_spellingword" isCurator={true} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load entry data/);
    });
  });
});

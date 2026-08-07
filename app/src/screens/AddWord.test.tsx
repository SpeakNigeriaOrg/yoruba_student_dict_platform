// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AddWord } from './AddWord.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/kaikki-search')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: overrides.kaikkiResults ?? [
            {
              form: 'testform',
              pos: 'noun',
              glosses: ['a test gloss'],
              matchedVia: 'yoruba_exact',
              altOfTargets: [],
              standardForms: ['testform'],
              entryId: 'en-test-yo-noun-ABC123',
              etymologyNumber: '2',
            },
          ],
        }),
      });
    }
    if (url.includes('/vocab-search')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: overrides.vocabResults ?? [
            { wordId: 'existing_component', displayText: 'existingspelling', syllables: ['exi', 'sting'], definition: null, baseSpelling: 'existingspelling', matchedVia: 'yoruba_exact' },
          ],
        }),
      });
    }
    if (url.includes('/duplicate-check')) {
      return Promise.resolve({ ok: true, json: async () => ({ matches: overrides.duplicates ?? [] }) });
    }
    if (url.includes('/words') || url.includes('/phrases')) {
      return Promise.resolve({ ok: true, json: async () => ({ wordId: 'created_word' }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe('AddWord - Word tab', () => {
  it('searches Kaikki, picks a result, and shows a syllables preview and word_id preview', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.getByLabelText('Syllables (comma-separated)')).toHaveValue('te,stfo,rm');

    await user.clear(screen.getByLabelText(/Word ID hint/));
    await user.type(screen.getByLabelText(/Word ID hint/), 'meaning');

    expect(screen.getByText('testform_meaning')).toBeInTheDocument();
  });

  it('submits createWord citing the picked etymology, not just its spelling', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.clear(screen.getByLabelText(/Word ID hint/));
    await user.type(screen.getByLabelText(/Word ID hint/), 'meaning');

    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Added testform_meaning to vocabulary.');
    });

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/words');
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({
      wordId: 'testform_meaning',
      displayText: 'testform',
      syllables: ['te', 'stfo', 'rm'],
      // Seeded from the etymology's primary gloss, not typed from scratch.
      definition: 'a test gloss',
      // The whole point: identity travels with the word, and never has to be
      // guessed back from 'testform' later.
      citation: { entryId: 'en-test-yo-noun-ABC123' },
    });
  });

  it('shows which etymology a result is, so several senses of one spelling can be told apart', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));

    expect(screen.getByLabelText('Kaikki search results')).toHaveTextContent('etymology 2');
  });

  it('seeds the student definition from the etymology and shows what it is simplifying', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.getByLabelText('Student definition')).toHaveValue('a test gloss');
    expect(screen.getByLabelText('Upstream glosses')).toHaveTextContent('Wiktionary says: a test gloss');
    expect(screen.getByText(/simplification, not a correction/)).toBeInTheDocument();
  });

  it('cannot submit before an etymology is picked', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));

    expect(screen.queryByRole('button', { name: 'Add to vocabulary' })).not.toBeInTheDocument();
  });

  it('refuses to cite a Kaikki record with no etymology id (a corpus ingested before 0014)', async () => {
    const fetchMock = mockFetch({
      kaikkiResults: [
        { form: 'testform', pos: 'noun', glosses: ['g'], matchedVia: 'yoruba_exact', altOfTargets: [], standardForms: ['testform'], entryId: null, etymologyNumber: null },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.getByRole('button', { name: 'Add to vocabulary' })).toBeDisabled();
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/words')).toBeUndefined();
  });

  describe('the off-path branch: a word with no Wiktionary entry', () => {
    it('warns, and names the preferred route rather than just allowing it', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();

      render(<AddWord />);
      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));

      expect(screen.getByLabelText('Off-path warning')).toHaveTextContent('ask a curator to add it to Wiktionary first');
    });

    it('will not submit until the exemption is explained', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();

      render(<AddWord />);
      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));
      await user.type(screen.getByLabelText('Spelling'), 'rédíò');
      await user.type(screen.getByLabelText(/Word ID hint/), 'radio');

      expect(screen.getByRole('button', { name: 'Add to vocabulary' })).toBeDisabled();
    });

    it('submits an explicit exemption, never a blank one', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      render(<AddWord />);
      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));
      await user.type(screen.getByLabelText('Spelling'), 'redio');
      await user.type(screen.getByLabelText(/Word ID hint/), 'radio');
      await user.type(screen.getByLabelText(/not in Wiktionary/), 'recent loanword');
      await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added redio_radio'));
      const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/words')![1].body);
      expect(body.citation).toEqual({ exemptReason: 'recent loanword' });
    });

    it('leaving the off-path branch clears it, so the two paths cannot be half-entered', async () => {
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();

      render(<AddWord />);
      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));
      await user.type(screen.getByLabelText('Spelling'), 'redio');
      await user.click(screen.getByRole('button', { name: 'Back to search' }));

      expect(screen.queryByLabelText('Spelling')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add to vocabulary' })).not.toBeInTheDocument();
    });
  });

  it('shows a duplicate warning when the duplicate-check endpoint reports matches', async () => {
    const fetchMock = mockFetch({ duplicates: [{ wordId: 'dupe_word', displayText: 'testform', reason: 'identical spelling' }] });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Duplicate warning')).toHaveTextContent('identical spelling');
    });
  });
});

describe('AddWord - Phrase tab', () => {
  it('adds a searched component, derives display text/syllables, and submits createPhrase', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    await user.click(screen.getByRole('button', { name: 'Search' }));
    // Found and listed by its SPELLING, not its word_id. Picking a word_id is still picking one
    // etymology - that is the point of the phrase tab - but the id is a key, and leading with it
    // made the list unreadable to anyone who did not already know our naming scheme.
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const componentsList = screen.getByLabelText('Phrase components');
    expect(componentsList).toHaveTextContent('existingspelling');
    expect(componentsList).not.toHaveTextContent('existing_component');

    await user.type(screen.getByLabelText('Word ID hint'), 'phrasehint');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Added phrase');
    });

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/phrases');
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({
      wordId: 'existingspelling_phrasehint',
      displayText: 'existingspelling',
      syllables: ['exi', 'sting'],
      components: ['existing_component'],
    });
  });

  it('refuses to submit with no components', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('A phrase needs at least one component.');
    });
  });

  it('removing a component chip removes it from the list', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByLabelText('Phrase components')).toHaveTextContent('existingspelling');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('No components picked yet.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The result list says whether an etymology is already in the dictionary
// ---------------------------------------------------------------------------
// It used to say nothing, so a curator picked `jẹun`, filled in the form, and only then read
// "identical spelling" - a resemblance, when the question is identity and the answer was exact.

const RESULT = {
  form: 'jẹun',
  pos: 'verb',
  glosses: ['to eat food'],
  matchedVia: 'yoruba_exact',
  altOfTargets: [],
  standardForms: ['jẹun'],
  entryId: 'en-jẹun-yo-verb--GhTRT14',
  etymologyNumber: null,
};

async function searchWith(result: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const fetchMock = mockFetch({ kaikkiResults: [result] });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<AddWord {...props} />);
  await user.type(screen.getByPlaceholderText('Search Kaikki by spelling or meaning...'), 'jẹun');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText(/to eat food/);
  return user;
}

describe('AddWord - is this etymology already taken?', () => {
  it('marks a result already in the dictionary, and names the word that IS it', async () => {
    await searchWith({ ...RESULT, claim: { status: 'in_dictionary', wordId: 'jeun_eat', displayText: 'jẹun' }, spellingMatches: [] });

    expect(screen.getByText('already in the dictionary')).toBeInTheDocument();
    expect(screen.getByText(/as jeun_eat/)).toBeInTheDocument();
  });

  it('replaces Select with Open for it - a form that cannot be submitted must not be offered', async () => {
    const onOpenWord = vi.fn();
    const user = await searchWith(
      { ...RESULT, claim: { status: 'in_dictionary', wordId: 'jeun_eat', displayText: 'jẹun' }, spellingMatches: [] },
      { onOpenWord },
    );

    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open jeun_eat' }));
    expect(onOpenWord).toHaveBeenCalledWith('jeun_eat');
  });

  it('marks a REQUESTED etymology but keeps Select - adding it is what fulfils the request', async () => {
    await searchWith({ ...RESULT, claim: { status: 'requested', wordId: 'planned_word', displayText: 'jẹun', contributionId: 'c1' }, spellingMatches: [] });

    expect(screen.getByText('requested, not added yet')).toBeInTheDocument();
    expect(screen.getByText(/planned as planned_word/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
  });

  it('says NOTHING for a free etymology - a badge on every row is a badge nobody reads', async () => {
    await searchWith({ ...RESULT, claim: null, spellingMatches: [] });

    expect(screen.queryByText('already in the dictionary')).not.toBeInTheDocument();
    expect(screen.queryByText('requested, not added yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
  });

  it('mentions a shared spelling only where identity is silent, and says so is what it is', async () => {
    await searchWith({ ...RESULT, claim: null, spellingMatches: [{ wordId: 'pako_timber', displayText: 'pákó' }] });

    expect(screen.getByText('same spelling as pako_timber')).toBeInTheDocument();
    expect(screen.getByText(/a different etymology, or a word we cannot compare by id/)).toBeInTheDocument();
  });

  it('says nothing at all when the server did not look (claim undefined)', async () => {
    // An unenriched result must not be reported as available - that would be a reassurance we have
    // not earned, and it is why undefined and null are kept apart.
    await searchWith(RESULT);

    expect(screen.queryByText('already in the dictionary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
  });
});

describe('AddWord - clicking Select is visibly acknowledged', () => {
  it('marks the chosen row and moves to a focusable confirmation region', async () => {
    // The complaint: "there is no indication that I selected anything... I have to have faith the
    // selection was made, then scroll down through a long list of search terms to confirm it."
    const user = await searchWith({ ...RESULT, claim: null, spellingMatches: [] });

    expect(screen.queryByLabelText('Selected etymology')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select' }));

    const region = screen.getByLabelText('Selected etymology');
    expect(region).toBeInTheDocument();
    expect(region).toHaveFocus();
    expect(screen.getByLabelText('Cited etymology')).toHaveTextContent('Citing:');
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-current', 'true');
  });

  it('keeps ONE status region, so the submit banner stays unambiguous', async () => {
    // The confirmation announces via aria-live rather than role="status": a second status region would
    // break every getByRole('status') assertion in this file.
    const user = await searchWith({ ...RESULT, claim: null, spellingMatches: [] });
    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });
});

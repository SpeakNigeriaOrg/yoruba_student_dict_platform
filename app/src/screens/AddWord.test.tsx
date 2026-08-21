// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { syllabifyWord } from '@yoruba-student-dict-platform/shared';
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

    it('opens with the word that was just searched for, not an empty box', async () => {
      // Reaching this branch means "I looked for this and it is not there", so the spelling is the
      // query. It used to clear the field and ask for it again, at the one moment the answer was
      // already on screen - the query was private to SearchBox and nothing carried it across.
      vi.stubGlobal('fetch', mockFetch({ kaikkiResults: [] }));
      const user = userEvent.setup();

      render(<AddWord />);
      await user.type(screen.getByPlaceholderText('Search Kaikki by spelling or meaning...'), 'redio');
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await waitFor(() => screen.getByText('No results.'));

      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));

      expect(screen.getByLabelText('Spelling')).toHaveValue('redio');
      // And it arrives with its grids, so the tone is one tap rather than a retype.
      expect(screen.getByLabelText('Tone of syllable 1')).toBeInTheDocument();
    });

    it('gives the authored spelling a tone grid, which is the one branch that had none', async () => {
      // The gap: a cited word arrives spelled by upstream, tones included, and the radios only
      // choose between forms Wiktionary already wrote. This branch is where a human authors the
      // spelling - and it was a bare text box, so the tone marks had to be typed. No phone keyboard
      // produces them, and an exempt word has no upstream form to be corrected against later, so
      // whatever was typed became golden_record permanently.
      vi.stubGlobal('fetch', mockFetch());
      const user = userEvent.setup();

      render(<AddWord />);
      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));
      await user.type(screen.getByLabelText('Spelling'), 'redio');

      // Three syllables, each with its own tone control - re · di · o.
      expect(screen.getByLabelText('Tone of syllable 1')).toBeInTheDocument();
      expect(screen.getByLabelText('Tone of syllable 3')).toBeInTheDocument();
      // And the six letters no keyboard has, without which `ẹ` `ọ` `ṣ` cannot be entered at all.
      expect(screen.getByRole('group', { name: 'Yoruba letters' })).toBeInTheDocument();
    });

    it('records the tone the grid produced, never a mark anyone typed', async () => {
      const fetchMock = mockFetch();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      render(<AddWord />);
      await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));
      await user.type(screen.getByLabelText('Spelling'), 'redio');
      // High on the second syllable: re · dí · o.
      await user.click(screen.getByLabelText('Syllable 2 high tone'));
      await user.type(screen.getByLabelText('Why is this word not in Wiktionary?'), 'recent loanword');
      await user.type(screen.getByLabelText(/Word ID hint/), 'radio');
      await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('to vocabulary'));
      const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/words')![1].body);
      expect(body.displayText).toBe('redío');
      // Derived from the same grids that produced the spelling, so the two cannot disagree - which
      // is a real production defect (agunfon_giraffe: 'àgùnfon' against ['à','gùn','fọn']), not a
      // hypothetical one. There is no comma-separated box on this branch to disagree from.
      expect(body.syllables).toEqual(['re', 'dí', 'o']);
      expect(screen.queryByLabelText('Syllables (comma-separated)')).not.toBeInTheDocument();
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
  it('submits the AUTHORED spelling and its own syllables, with the components as a separate claim', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    // Scoped: the Phrase tab has two searches now - one over the dictionary, one over Wiktionary for a
    // word we do not hold yet.
    const dictSearch = () => within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
    await user.click(dictSearch().getByRole('button', { name: 'Search' }));
    // Found and listed by its SPELLING, not its word_id. Picking a word_id is still picking one
    // etymology - that is the point of the phrase tab - but the id is a key, and leading with it
    // made the list unreadable to anyone who did not already know our naming scheme.
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));

    const componentsList = screen.getByLabelText('Phrase components');
    expect(componentsList).toHaveTextContent('existingspelling');
    expect(componentsList).not.toHaveTextContent('existing_component');

    // The spelling arrives from the component, so nothing is typed here and the tone grid is never
    // opened. It is still SUBMITTED as an explicit display_text - the default is in the form, not in
    // the storage rule.
    expect(spelledFromComponents()).toBe('existingspelling');
    expect(screen.queryByLabelText('The phrase, spelled as it is said')).toBeNull();
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
      // From the composed text, not from the component's stored ['exi','sting']. The syllabifier
      // refuses this ASCII fixture spelling, so it stands as one unit exactly as typed - the same
      // rule the composer itself follows, which is what keeps the two in step.
      syllables: ['existingspelling'],
      components: ['existing_component'],
      // The default, not a blank - see EMPTY_DRAFT. A locally composed phrase has no citation pin to
      // read a pos from, so a blank one leaves it recorded nowhere.
      pos: 'phrase',
      englishGloss: null,
      // Null only because this fixture has no gloss to copy from. Sent as a real field now: a phrase
      // used to be created with definition null unconditionally, the column not even named.
      definition: null,
    });
  });

  it('stores a phrase whose spelling its parts cannot produce, and says what differs', async () => {
    // The case that was unstorable. Upstream's `o ṣe` entry carries canonical form `o ṣé` with IPA
    // /ō ʃé/, while its parts are `o` (pron, etym 2) and `ṣe` (verb, etym 2) - so joining the parts
    // spelled it `o ṣe`, at a tone nobody says, and the tone grid then taught that tone to a
    // volunteer. Minting a `ṣé` word instead is blocked by 0017: it would cite `ṣe`'s etymology.
    const fetchMock = mockFetch({
      vocabResults: [
        { wordId: 'o_you', displayText: 'o', syllables: ['o'], definition: 'you', baseSpelling: 'o', matchedVia: 'yoruba_exact' },
        { wordId: 'se_do', displayText: 'ṣe', syllables: ['ṣe'], definition: 'to do', baseSpelling: 'se', matchedVia: 'yoruba_exact' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    const dict = within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
    await user.click(dict.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('to do', { exact: false }));
    const add = screen.getAllByRole('button', { name: 'Add as component' });
    await user.click(add[0]);
    await user.click(add[1]);

    // Arrives as `o ṣe` - the components' own spellings - which is exactly the form that is wrong
    // here, so this is the case the default must stay correctable in.
    expect(spelledFromComponents()).toBe('o ṣe');
    await openSpelling(user);
    // The grid opens holding what the parts spell, so correcting one tone is an edit rather than a
    // retype from nothing - which is the whole reason the components go first.
    const spelling = screen.getByLabelText('The phrase, spelled as it is said');
    expect((spelling as HTMLInputElement).value).toBe('o ṣe');
    await user.clear(spelling);
    // Emptying it does NOT hand the field back to the components: an empty box that refills itself
    // appends the retyped form to a default that came back mid-edit.
    expect((spelling as HTMLInputElement).value).toBe('');
    await user.type(spelling, 'o ṣé');

    // Reported, not corrected: the difference is a real fact about the phrase.
    const warning = await screen.findByLabelText('Spelling differs from components');
    expect(warning).toHaveTextContent('ṣe is written ṣé here');
    expect(warning).toHaveTextContent('o ṣe');

    await user.type(screen.getByLabelText('Word ID hint'), 'thank_you');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added phrase'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/phrases')![1].body);
    expect(body.displayText).toBe('o ṣé');
    expect(body.syllables).toEqual(['o', 'ṣé']);
    expect(body.components).toEqual(['o_you', 'se_do']);
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
    await user.click(
      within(screen.getByRole('search', { name: 'Search words already in the dictionary' })).getByRole('button', {
        name: 'Search',
      }),
    );
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));

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
  // Wait on the result ROW rather than a particular gloss, so this helper works for any fixture.
  await screen.findByRole('listitem');
  return user;
}

// ---------------------------------------------------------------------------
// The default flow: the components spell the phrase
// ---------------------------------------------------------------------------
// The spelling field was authored-only, on a blank tone grid, for every phrase - including the
// overwhelming majority whose spelling is exactly the words that were just picked from the
// dictionary, separated by spaces. That made re-entry mandatory, and re-entry is not confirmation:
// it is a second chance to differ from the words already listed. The components propose now, and a
// correction is still a correction.

describe('AddWord - a word may say what it is built from, but is not asked to', () => {
  /** Gets to the filled-in word form, which is where the section lives. */
  async function wordFormWith(fetchMock: ReturnType<typeof mockFetch>) {
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.clear(screen.getByLabelText(/Word ID hint/));
    await user.type(screen.getByLabelText(/Word ID hint/), 'meaning');
    return user;
  }

  const openComponents = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /Is this word built from other words/ }));

  /** Adds the first n of TWO_WORDS through the section's own picker. */
  async function addComponents(user: ReturnType<typeof userEvent.setup>, count: number) {
    const box = within(screen.getByRole('search', { name: 'Search words this one is built from' }));
    await user.click(box.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('sky', { exact: false }));
    const add = screen.getAllByRole('button', { name: 'Add as component' });
    for (let i = 0; i < count; i += 1) await user.click(add[i]);
  }

  it('stays shut, so the ordinary word is never asked the question', async () => {
    await wordFormWith(mockFetch({ vocabResults: TWO_WORDS }));

    expect(screen.getByRole('button', { name: /Is this word built from other words/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Word components section')).toBeNull();
    expect(screen.queryByRole('search', { name: 'Search words this one is built from' })).toBeNull();
  });

  it('sends no components at all when the section was never opened', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await wordFormWith(fetchMock);
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/words')![1].body);
    // Absent, not []. An atomic word makes no claim about its parts; an empty array would say the
    // question had been considered and answered.
    expect('components' in body).toBe(false);
  });

  it('submits the picked components in order once the section is opened', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await wordFormWith(fetchMock);
    await openComponents(user);
    await addComponents(user, 2);

    expect(screen.getByLabelText('Word components')).toHaveTextContent('ojú');
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/words')![1].body);
    expect(body.components).toEqual(['oju_face', 'sanma_sky']);
    // The citation is untouched by any of this: a word's identity is still the etymology it cites,
    // and its decomposition is a separate claim about it.
    expect(body.citation).toEqual({ entryId: 'en-test-yo-noun-ABC123' });
  });

  it('removes by position, so a reduplication can lose just one of its two', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await wordFormWith(fetchMock);
    await openComponents(user);
    await addComponents(user, 1);
    await user.click(screen.getAllByRole('button', { name: 'Add as component' })[0]);
    expect(screen.getByLabelText('Word components').querySelectorAll('li')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(screen.getByLabelText('Word components').querySelectorAll('li')).toHaveLength(1);
  });

  it('says what it is holding when it is collapsed again, rather than hiding it', async () => {
    // A shut section concealing a filled-in answer is how a submission comes to carry something
    // nobody remembers entering.
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await wordFormWith(fetchMock);
    await openComponents(user);
    await addComponents(user, 2);
    await user.click(screen.getByRole('button', { name: 'Hide' }));

    expect(screen.queryByLabelText('Word components section')).toBeNull();
    expect(screen.getByLabelText('Components picked while collapsed')).toHaveTextContent('ojú + sánmà');

    // And they are still submitted - collapsing is not discarding.
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/words')![1].body);
    expect(body.components).toEqual(['oju_face', 'sanma_sky']);
  });

  it('clears and closes the section after a word is added, so the next word starts clean', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await wordFormWith(fetchMock);
    await openComponents(user);
    await addComponents(user, 2);
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added'));

    // The form resets to the search, so the section goes with it - a second word inheriting the
    // first one's parts is the failure this guards.
    expect(screen.queryByLabelText('Word components section')).toBeNull();
    expect(screen.queryByLabelText('Components picked while collapsed')).toBeNull();
  });
});

const TWO_WORDS = [
  { wordId: 'oju_face', displayText: 'ojú', syllables: ['o', 'jú'], definition: 'eye, face', baseSpelling: 'oju', matchedVia: 'yoruba_exact' },
  { wordId: 'sanma_sky', displayText: 'sánmà', syllables: ['sán', 'mà'], definition: 'sky', baseSpelling: 'sanma', matchedVia: 'yoruba_exact' },
];

/** Adds the first n of TWO_WORDS as components and returns the user. */
async function phraseWithComponents(count: number, fetchMock: ReturnType<typeof mockFetch>) {
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<AddWord />);
  await user.click(screen.getByRole('button', { name: 'Phrase' }));
  const dict = within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
  await user.click(dict.getByRole('button', { name: 'Search' }));
  await waitFor(() => screen.getByText('sky', { exact: false }));
  const add = screen.getAllByRole('button', { name: 'Add as component' });
  for (let i = 0; i < count; i += 1) await user.click(add[i]);
  return user;
}

/** The tone grid, which now exists only once a curator has asked to correct the spelling. */
const spellingField = () => screen.getByLabelText('The phrase, spelled as it is said') as HTMLInputElement;
/** What the parts spell, read off the default's read-out.
 *
 * Sliced off the prefix rather than matched as a substring: `toHaveTextContent('ojú')` passes just as
 * happily against `ojú sánmà`, which would have let a component removal go unnoticed. */
const spelledFromComponents = () =>
  screen.getByLabelText('Spelled from the components').textContent!.replace(/^.*components: /, '');
/** Takes the optional branch: the phrase is not said the way its parts are written. */
const openSpelling = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /correct the spelling/ }));

describe('AddWord - a phrase is spelled from its components until it is not', () => {
  it('fills the spelling in as each component is added, and says that is where it came from', async () => {
    const user = await phraseWithComponents(1, mockFetch({ vocabResults: TWO_WORDS }));
    expect(spelledFromComponents()).toBe('ojú');
    // And no tone grid on screen: the default flow reads the spelling off the parts rather than
    // asking for it.
    expect(screen.queryByLabelText('The phrase, spelled as it is said')).toBeNull();

    // Still following: the second word extends it rather than being ignored.
    await user.click(screen.getAllByRole('button', { name: 'Add as component' })[1]);
    expect(spelledFromComponents()).toBe('ojú sánmà');

    // And removing one takes it back out, which a copied-on-add spelling would not have done.
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(spelledFromComponents()).toBe('ojú');
  });

  it('submits the default with no typing at all, as an explicit spelling and syllables', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await phraseWithComponents(2, fetchMock);
    await user.type(screen.getByLabelText('Word ID hint'), 'sky');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added phrase'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/phrases'))![1].body);
    // Storage is unchanged by any of this: display_text is sent, not derived server-side. The
    // default lives in the form.
    expect(body.displayText).toBe('ojú sánmà');
    expect(body.syllables).toEqual([...syllabifyWord('ojú'), ...syllabifyWord('sánmà')]);
    expect(body.components).toEqual(['oju_face', 'sanma_sky']);
    expect(body.wordId).toBe('oju_sanma_sky');
  });

  it('keeps a correction when another component is added afterwards', async () => {
    // The failure mode of copying the default into the draft on every add: `mu` + `ọtí` is written
    // `muti`, and picking the second word must not spell it back out again.
    const user = await phraseWithComponents(1, mockFetch({ vocabResults: TWO_WORDS }));
    await openSpelling(user);
    await user.clear(spellingField());
    await user.type(spellingField(), 'ojúsánmà');
    await user.click(screen.getAllByRole('button', { name: 'Add as component' })[1]);

    expect(spellingField().value).toBe('ojúsánmà');
    // And now it reports, correctly, that this is not its parts run together.
    expect(screen.getByLabelText('Spelling differs from components')).toBeInTheDocument();
    expect(screen.queryByLabelText('Spelled from the components')).toBeNull();
  });

  it('offers the components\' spelling back, so a correction is cheap to undo', async () => {
    const user = await phraseWithComponents(2, mockFetch({ vocabResults: TWO_WORDS }));
    await openSpelling(user);
    await user.clear(spellingField());
    await user.type(spellingField(), 'wrong');
    const undo = screen.getByRole('button', { name: /Spell it from the components/ });
    expect(undo).toHaveTextContent('ojú sánmà');

    await user.click(undo);
    // All the way back, not just back to the same string: the grid closes and the read-out returns,
    // so a third word would extend it again.
    expect(screen.queryByLabelText('The phrase, spelled as it is said')).toBeNull();
    expect(spelledFromComponents()).toBe('ojú sánmà');
    expect(screen.queryByRole('button', { name: /Spell it from the components/ })).toBeNull();
  });

  it('lets a curator who opened the grid by mistake close it again, having typed nothing', async () => {
    // The way back used to appear only once the correction DIFFERED from the default, which is the
    // one state this curator is not in.
    const user = await phraseWithComponents(2, mockFetch({ vocabResults: TWO_WORDS }));
    await openSpelling(user);
    await user.click(screen.getByRole('button', { name: /Spell it from the components/ }));

    expect(screen.queryByLabelText('The phrase, spelled as it is said')).toBeNull();
    expect(spelledFromComponents()).toBe('ojú sánmà');
  });

  it('shows no spelling at all, in either state, before a component is picked', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    // Nothing to spell and nothing to spell it FROM, so the form opens on the component search -
    // which is the entrance the flow is meant to have.
    expect(screen.queryByLabelText('The phrase, spelled as it is said')).toBeNull();
    expect(screen.queryByLabelText('Spelled from the components')).toBeNull();
    expect(screen.queryByRole('button', { name: /correct the spelling/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Spell it from the components/ })).toBeNull();
  });

  it('defaults the part of speech to phrase, which is what a composed phrase usually is', async () => {
    // The corpus figure that argued for a blank default - 2.4% of multi-word entries tagged
    // `phrase` - counts ADOPTED entries, which take their pos from the pin and never show this
    // field. What we compose ourselves is what upstream has no entry for.
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    expect((screen.getByLabelText('Part of speech') as HTMLSelectElement).value).toBe('phrase');
  });
});

// ---------------------------------------------------------------------------
// The student definition starts as the dictionary wording
// ---------------------------------------------------------------------------
// The Phrase tab collected no student definition at all, and createPhrase did not even name the
// column - so every phrase ever added here was a dictionary entry that said nothing about what it
// meant, and the only way to give it one was to open the finished entry and use the entry axis. The
// field exists now, and it arrives holding the dictionary wording, because for a great many phrases
// that IS the student definition.

const definitionField = () => screen.getByLabelText('Student definition') as HTMLTextAreaElement;

describe('AddWord - the student definition of a phrase', () => {
  it('follows the English gloss as it is typed, and is submitted as its own field', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await phraseWithComponents(2, fetchMock);

    await user.type(screen.getByLabelText('English gloss'), 'the sky, the firmament');
    expect(definitionField().value).toBe('the sky, the firmament');

    await user.type(screen.getByLabelText('Word ID hint'), 'sky');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added phrase'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/phrases'))![1].body);
    // Two columns holding one wording, which is the ordinary case and still not one column: 0018's
    // gloss is what we would publish upstream and the definition is what a student reads.
    expect(body.definition).toBe('the sky, the firmament');
    expect(body.englishGloss).toBe('the sky, the firmament');
  });

  it('keeps a simplification, and stops following the gloss once there is one', async () => {
    const fetchMock = mockFetch({ vocabResults: TWO_WORDS });
    const user = await phraseWithComponents(2, fetchMock);
    await user.type(screen.getByLabelText('English gloss'), 'the sky, the firmament');
    await user.clear(definitionField());
    await user.type(definitionField(), 'the sky');

    // Editing the gloss afterwards must not overwrite the simpler wording - that is the whole
    // difference between a default and a derivation.
    await user.type(screen.getByLabelText('English gloss'), '; the heavens');
    expect(definitionField().value).toBe('the sky');

    await user.type(screen.getByLabelText('Word ID hint'), 'sky');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added phrase'));
    const body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/phrases'))![1].body);
    expect(body.definition).toBe('the sky');
    expect(body.englishGloss).toBe('the sky, the firmament; the heavens');
  });

  it('offers the dictionary wording back once the two differ', async () => {
    const user = await phraseWithComponents(2, mockFetch({ vocabResults: TWO_WORDS }));
    await user.type(screen.getByLabelText('English gloss'), 'the firmament');
    // Nothing to undo while it is still a copy.
    expect(screen.queryByRole('button', { name: /Use the dictionary wording/ })).toBeNull();

    await user.clear(definitionField());
    await user.type(definitionField(), 'the sky');
    await user.click(screen.getByRole('button', { name: /Use the dictionary wording/ }));

    expect(definitionField().value).toBe('the firmament');
    expect(screen.queryByRole('button', { name: /Use the dictionary wording/ })).toBeNull();
  });
});

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

describe('AddWord - spelling and syllables cannot drift apart', () => {
  const TWO_SPELLINGS = {
    form: 'adìyẹ',
    pos: 'noun',
    glosses: ['chicken'],
    matchedVia: 'yoruba_exact',
    altOfTargets: [],
    // Two standard forms, so the "choose a spelling" radios render.
    standardForms: ['adìyẹ', 'adiye'],
    entryId: 'en-adiye-yo-noun-ABC',
    etymologyNumber: null,
    claim: null,
    spellingMatches: [],
  };

  it('re-splits the syllables when a different spelling is chosen', async () => {
    // The reported bug: switching spelling left the PREVIOUS form's syllables in the box, and nothing
    // downstream checks the pair - words.ts only requires a non-empty array of strings - so the
    // mismatch became the word's canonical split.
    const user = await searchWith(TWO_SPELLINGS);
    await user.click(screen.getByRole('button', { name: 'Select' }));

    const syllables = () => (screen.getByLabelText('Syllables (comma-separated)') as HTMLInputElement).value;
    const first = syllables();
    expect(first).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'adiye' }));

    // The value must correspond to the NEWLY chosen spelling, not the previous one.
    expect(syllables()).toBe(syllabifyWord('adiye').join(','));
    expect(syllables()).not.toBe(first);
  });

  it('submits a spelling and syllables that agree, after switching', async () => {
    // What actually reaches the server is the pair, so assert the pair.
    const user = await searchWith(TWO_SPELLINGS);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('radio', { name: 'adiye' }));
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added'));
    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes('/api/words'))![1].body,
    );
    expect(body.displayText).toBe('adiye');
    expect(body.syllables).toEqual(syllabifyWord('adiye'));
  });
});

// ---------------------------------------------------------------------------
// A multi-word entry is a phrase
// ---------------------------------------------------------------------------
// Wiktionary has no rule against multi-word entries, so they appear in the Add WORD search alongside
// single words - and adding one there produced a row that was really a phrase. Only 5 of the 480
// multi-word corpus entries have every constituent word already in the dictionary, which is why the
// redirect alone would not have been enough: it needs somewhere to land that can actually finish.

const MULTIWORD = {
  form: 'ọmọ odù',
  pos: 'noun',
  glosses: ['one of the sixteen principal signs'],
  matchedVia: 'yoruba_exact',
  altOfTargets: [],
  standardForms: ['ọmọ odù'],
  entryId: 'en-ọmọ odù-yo-noun-XYZ',
  etymologyNumber: null,
  claim: null,
  spellingMatches: [],
};

describe('AddWord - a multi-word entry is a phrase', () => {
  it('labels a multi-word search result rather than offering it as a word', async () => {
    await searchWith(MULTIWORD);
    expect(screen.getByText('multi-word - add as a phrase')).toBeInTheDocument();
  });

  it('selecting one lands on the Phrase tab, citing the whole phrase and naming its words', async () => {
    // The requested behaviour: it still SURFACES in the word search, but picking it switches tabs with
    // the fields populated rather than filling in a word form.
    const user = await searchWith(MULTIWORD);
    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.getByLabelText('Add phrase tab')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add word tab')).not.toBeInTheDocument();
    // The phrase's OWN etymology is carried over, not discarded.
    expect(screen.getByLabelText('Adopted etymology')).toHaveTextContent('ọmọ odù');
    // And it says how many words there are to add.
    expect(screen.getByRole('status')).toHaveTextContent('2 words');
  });

  it('refuses to submit a multi-word spelling as a word, and posts nothing', async () => {
    // The backstop, reachable by typing a space into the off-path spelling field.
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AddWord />);

    await user.click(screen.getByRole('button', { name: "This word isn't in Wiktionary" }));
    await user.type(screen.getByLabelText('Spelling'), 'ọmọ odù');
    await user.type(screen.getByLabelText('Why is this word not in Wiktionary?'), 'local compound');
    await user.type(screen.getByLabelText(/Word ID hint/), 'sign');
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    expect(screen.getByRole('status')).toHaveTextContent('belongs on the Phrase tab');
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/words')).length).toBe(0);
  });
});

describe('AddWord - the phrase path can finish the job', () => {
  const MISSING_PART = {
    form: 'odù',
    pos: 'noun',
    glosses: ['a divination sign'],
    matchedVia: 'yoruba_exact',
    altOfTargets: [],
    standardForms: ['odù'],
    entryId: 'en-odù-yo-noun-PART',
    etymologyNumber: null,
    claim: null,
    spellingMatches: [],
  };

  const UPSTREAM_PHRASE = {
    form: 'o ṣé',
    pos: 'intj',
    glosses: ['thank you (non-honorific, to a singular person)'],
    matchedVia: 'yoruba_exact',
    altOfTargets: [],
    standardForms: ['o ṣé'],
    entryId: 'en-o-ṣe-yo-intj-NEW',
    etymologyNumber: null,
    claim: null,
    spellingMatches: [],
  };

  it('adopts a Wiktionary phrase in place, rather than refusing it as "not one word of this one"', async () => {
    // Upstream holds 480 multi-word entries and spells them with the tones we would otherwise
    // guess at - `o ṣé`, not `o ṣe`. This search refused every one of them, because it was written
    // to find a missing COMPONENT and a phrase is not one. True, and the wrong outcome: the only
    // route to adopting one ran through the Word tab, which refuses it too and hands it back here.
    const fetchMock = mockFetch({ kaikkiResults: [UPSTREAM_PHRASE] });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    // A component picked before finding the whole entry is kept, not reset.
    const dict = within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
    await user.click(dict.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));

    const upstream = within(
      screen.getByRole('search', { name: 'Search Wiktionary for this phrase, or for a missing word' }),
    );
    await user.click(upstream.getByRole('button', { name: 'Search' }));
    await waitFor(() => upstream.getByRole('button', { name: 'Use as this phrase' }));
    await user.click(upstream.getByRole('button', { name: 'Use as this phrase' }));

    // Upstream's own spelling, tone included - the half that was being lost.
    expect(screen.getByLabelText('The phrase, spelled as it is said')).toHaveValue('o ṣé');
    expect(screen.getByLabelText('Adopted etymology')).toHaveTextContent('o ṣé');
    expect(screen.getByLabelText('Phrase components')).toHaveTextContent('existingspelling');

    // And a component added AFTER adopting does not spell over it. The default follows the
    // components only until something better is on the field, and upstream's canonical form is
    // exactly that - it is the reason for carrying the entry over at all.
    await user.click(screen.getByRole('button', { name: 'Add as component' }));
    expect(screen.getByLabelText('The phrase, spelled as it is said')).toHaveValue('o ṣé');

    // An adopted phrase cites its own etymology, and does not re-ask for what the pin holds.
    expect(screen.queryByLabelText('Part of speech')).not.toBeInTheDocument();

    // The student definition is asked for anyway, because no pin can hold it - the wording a student
    // reads is ours, cited or not. Seeded from upstream's gloss, which is what there is to simplify.
    expect((screen.getByLabelText('Student definition') as HTMLTextAreaElement).value).toBe(
      'thank you (non-honorific, to a singular person)',
    );
    expect(screen.getByLabelText('Upstream glosses')).toHaveTextContent('thank you');

    await user.type(screen.getByLabelText('Word ID hint'), 'thank_you');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/phrases'));
    const body = JSON.parse(call![1].body);
    expect(body.displayText).toBe('o ṣé');
    expect(body.definition).toBe('thank you (non-honorific, to a singular person)');
    expect(body.citation).toEqual({ entryId: 'en-o-ṣe-yo-intj-NEW' });
    // Two syllables, and the space is in neither - it is orthography, not a tone-bearing unit.
    expect(body.syllables).toEqual(['o', 'ṣé']);
  });

  it('offers the part of speech as upstream\'s own tags, not as a blank box', async () => {
    // The field is collected so a locally composed phrase can be sent upstream one day, which makes
    // the vocabulary a closed one. Free text could only ever record `interjection` where the sole
    // accepted value is `intj`, and nothing downstream would notice until publication.
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    const pos = screen.getByLabelText('Part of speech');
    expect(pos.tagName).toBe('SELECT');
    await user.selectOptions(pos, 'intj');

    const dict = within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
    await user.click(dict.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));
    await user.type(screen.getByLabelText('Word ID hint'), 'thank_you');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/phrases'));
    expect(JSON.parse(call![1].body).pos).toBe('intj');
  });

  it('routes to the Word tab to add a missing component, then brings it back into the phrase', async () => {
    // This is the 475-of-480 case. It used to be a dead end - the picker only saw golden_record and
    // createPhrase hard-failed - and was briefly a cut-down inline form here. Words are created in ONE
    // place now: the Word tab, with the whole form that job needs.
    const fetchMock = mockFetch({ kaikkiResults: [MISSING_PART] });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    // Build up some state first, so the round trip has something to lose.
    const dict = within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
    await user.click(dict.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));
    await user.type(screen.getByLabelText('Word ID hint'), 'phrasehint');

    const upstream = within(screen.getByRole('search', { name: 'Search Wiktionary for this phrase, or for a missing word' }));
    await user.click(upstream.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText(/a divination sign/));
    await user.click(upstream.getByRole('button', { name: 'Add it as a word first' }));

    // We are on the WORD tab, told why, with the etymology already picked.
    expect(screen.getByLabelText('Add word tab')).toBeInTheDocument();
    expect(screen.getByLabelText('Adding for a phrase')).toHaveTextContent('odù');
    expect(screen.getByLabelText('Cited etymology')).toHaveTextContent('odù');

    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    // Back on the phrase, with the new word appended AND the earlier work intact.
    await waitFor(() => expect(screen.getByLabelText('Add phrase tab')).toBeInTheDocument());
    const list = screen.getByLabelText('Phrase components');
    expect(list).toHaveTextContent('existingspelling');
    expect(list).toHaveTextContent('odù');
    expect((screen.getByLabelText('Word ID hint') as HTMLInputElement).value).toBe('phrasehint');

    // And the word was created through the normal word path, citing its own etymology.
    const body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/words'))![1].body);
    expect(body.citation).toEqual({ entryId: 'en-odù-yo-noun-PART' });
  });

  it('allows the same word twice, which is what a reduplication is', async () => {
    // `méjì méjì` was unrepresentable: the component list de-duplicated by wordId. The server never
    // had that restriction - component_position is the primary key.
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    const dict = within(screen.getByRole('search', { name: 'Search words already in the dictionary' }));
    await user.click(dict.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existingspelling', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));
    await user.click(screen.getByRole('button', { name: 'Add as component' }));

    const list = screen.getByLabelText('Phrase components');
    expect(list.querySelectorAll('li')).toHaveLength(2);
    // Both positions show up in the default spelling, which is the components in order - and because
    // that IS the spelling, the check has nothing to report about it.
    expect(spelledFromComponents()).toBe('existingspelling existingspelling');
    expect(screen.queryByLabelText('Spelling differs from components')).toBeNull();

    // Removing is by POSITION, so taking one out leaves the other.
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(screen.getByLabelText('Phrase components').querySelectorAll('li')).toHaveLength(1);
  });
});

describe('AddWord - after adding, you can add another', () => {
  it('clears the word form and keeps the confirmation', async () => {
    // Reported: the confirmation appears but the form stays filled at the bottom of a long page, so
    // adding a second word meant scrolling back up past everything.
    const user = await searchWith({ ...RESULT, claim: null, spellingMatches: [] });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added'));
    // The form is gone, so the search box is what is in front of the curator again.
    expect(screen.queryByLabelText('Selected etymology')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search Kaikki by spelling or meaning...')).toBeInTheDocument();
  });
});

describe('AddWord - the component picker says what it is offering', () => {
  const EXISTING_PHRASE = {
    wordId: 'e_joo_please',
    displayText: 'ẹ jọ̀ọ́',
    syllables: ['ẹ', 'jọ̀ọ́'],
    definition: 'Please',
    baseSpelling: 'e joo',
    matchedVia: 'yoruba_exact',
    entryType: 'phrase' as const,
  };

  async function searchDictionary(vocabResults: unknown[], props: Record<string, unknown> = {}) {
    vi.stubGlobal('fetch', mockFetch({ vocabResults }));
    const user = userEvent.setup();
    render(<AddWord {...props} />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));
    await user.click(
      within(screen.getByRole('search', { name: 'Search words already in the dictionary' })).getByRole('button', {
        name: 'Search',
      }),
    );
    await waitFor(() => screen.getByText('ẹ jọ̀ọ́', { exact: false }));
    return user;
  }

  it('marks a result that is itself a phrase', async () => {
    // Reported: searching the phrase tab for an existing phrase returned `ẹ jọ̀ọ́ — Please  [Add]`, which
    // read as an invitation to duplicate something that already existed. VocabSearchResult carried no
    // entryType, so the picker could not tell a phrase from a word.
    await searchDictionary([EXISTING_PHRASE]);
    expect(screen.getByText('already a phrase')).toBeInTheDocument();
  });

  it('names the action, so "Add" cannot be read as "create"', async () => {
    await searchDictionary([EXISTING_PHRASE]);
    expect(screen.getByRole('button', { name: 'Add as component' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('offers to OPEN an existing entry, which is what was actually wanted', async () => {
    const onOpenWord = vi.fn();
    const user = await searchDictionary([EXISTING_PHRASE], { onOpenWord });
    await user.click(screen.getByRole('button', { name: 'Open e_joo_please' }));
    expect(onOpenWord).toHaveBeenCalledWith('e_joo_please');
  });

  it('says where editing an existing phrase actually happens', async () => {
    // The Add screens only create. A phrase's components are edited on its Etymology axis, and nothing
    // on this screen used to say so.
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();
    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));
    expect(screen.getByText(/open it and use its Etymology tab/)).toBeInTheDocument();
  });
});

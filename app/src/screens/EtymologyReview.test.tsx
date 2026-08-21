// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EtymologyReview } from './EtymologyReview.js';
import { PhraseComposer } from './PhraseComposer.js';
import etymologyFixture from '../fixtures/etymologyReview.json';
import etymologyConfirmedFixture from '../fixtures/etymologyReviewConfirmed.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The manual component builder, the note, and "already confirmed as used in" are
 * behind a collapsed curator-tools disclosure now - assembling word_ids is a
 * curator instrument, and an empty picker was noise on a volunteer's phone. */
async function openCuratorTools(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Curator tools' }));
}

describe('EtymologyReview', () => {
  it('renders the real componentsProposal, and says what a decomposition IS before asking', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);

    await waitFor(() => {
      expect(screen.getByText('fixturegen2_compoundspelling')).toBeInTheDocument();
    });

    // Both real proposed components resolve, and are named by their SPELLING - never by the
    // word_id, which is a key and which this screen's own rule says not to show.
    expect(screen.getByText('fixturegen2_partonespelling')).toBeInTheDocument();
    expect(screen.getByText('fixturegen2_parttwospelling')).toBeInTheDocument();
    expect(screen.queryByText(/fixturegen2_partone_madeuppart/)).not.toBeInTheDocument();

    // The task explains itself with a real example, rather than leaving a reader to infer the genre
    // from a heading. This is the one thing the axis had only in a code comment.
    const explanation = screen.getByLabelText('What this task is');
    expect(explanation).toHaveTextContent('ibùsùn');
    expect(explanation).toHaveTextContent('place');
    expect(explanation).toHaveTextContent('sleep');
    // And it makes the etymology-not-spelling point, which is the whole reason for the axis.
    expect(explanation).toHaveTextContent('placenta');

    // Read-only entry context, and the axis status chip row.
    expect(screen.getByText(/a made-up compound word for fixture generation/)).toBeInTheDocument();
    const axisStatus = screen.getByLabelText('Review axis status');
    // Chips read "<axis>" when pending and "<axis> ✓" when done; this
    // fixture has nothing decided yet.
    expect(axisStatus).toHaveTextContent('entry');
    expect(axisStatus).toHaveTextContent('etymology');
    expect(axisStatus).toHaveTextContent('audio');
    expect(axisStatus).not.toHaveTextContent('✓');
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

  it('offers only the applicable answers: a proposal exists, no components on record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    // Accept / reject apply because there IS a proposal; "Confirm components" does
    // not, because none are on record - and it is now absent rather than a greyed
    // button with no explanation.
    expect(screen.getByRole('button', { name: 'Accept proposed components' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject this etymology' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Confirm components' })).not.toBeInTheDocument();
  });

  it('offers no accept/reject at all when there is nothing proposed to accept or reject', async () => {
    // The reported defect: "Accept proposed components" appeared, ENABLED, on a
    // word with no proposal - submitting accept_proposed over an empty list - and
    // "Reject this etymology" sat greyed out with nothing to reject.
    const fixture = { ...etymologyFixture, componentsProposal: [], components: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByRole('button', { name: 'Accept proposed components' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject this etymology' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm components' })).not.toBeInTheDocument();
    // Exactly one answer, and it is a positive claim about the word.
    expect(screen.getByRole('button', { name: 'It has no parts' })).toBeInTheDocument();
    expect(screen.getByText(/Wiktionary proposes no breakdown/)).toBeInTheDocument();
  });

  it('never offers a volunteer the curator-only "add this missing word" button', async () => {
    // It posts to POST /api/words, which is curator-only - a volunteer filling the
    // form in got a bare "403" at the end of it.
    const fixture = {
      ...etymologyFixture,
      componentsProposal: [
        { kaikkiForm: 'abo adìyẹ', wordId: null, ambiguous: false, possibleMatches: [], previewGlosses: ['hen'] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByRole('button', { name: /Add "abo adìyẹ" to vocabulary/ })).not.toBeInTheDocument();
    // And the note is no longer a dead end: the picker below can request it.
    expect(screen.getByText(/add it from the picker below and it will be requested/)).toBeInTheDocument();
    expect(screen.queryByText(/Ask a curator to add this word/)).not.toBeInTheDocument();
  });

  it('still offers a curator the add-missing-word button', async () => {
    const fixture = {
      ...etymologyFixture,
      componentsProposal: [
        { kaikkiForm: 'abo adìyẹ', wordId: null, ambiguous: false, possibleMatches: [], previewGlosses: ['hen'] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.getByRole('button', { name: /Add "abo adìyẹ" to vocabulary/ })).toBeInTheDocument();
  });

  it('lets a volunteer say the word DOES have parts, and name them', async () => {
    // The reported defect: with no proposal the only clickable answer was "It has no
    // parts", so a volunteer who disagreed had no way to record it - and every vote
    // said yes because yes was all there was.
    const fixture = { ...etymologyFixture, componentsProposal: [], components: [] };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => fixture });
      if (url.includes('/vocab-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { wordId: 'part_one_word', displayText: 'partone', syllables: ['part'], definition: null, baseSpelling: 'partone', matchedVia: 'yoruba_exact' },
            ],
          }),
        });
      }
      if (url.includes('/kaikki-search')) return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    await user.click(screen.getByRole('button', { name: 'It does have parts' }));
    expect(screen.getByLabelText('Component picker')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Search' }));
    // Found by its spelling, not its word_id - the id is a key, and a requested word's is
    // derived and deliberately never shown.
    await waitFor(() => screen.getByText(/partone/));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Propose: Save these parts' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      const body = JSON.parse((post![1] as RequestInit).body as string);
      // Structured, so consensus can tally it - not a free-text note.
      expect(body).toMatchObject({ componentsAction: 'custom', components: ['part_one_word'] });
    });
  });

  it('offers both answers, so neither axis can only record agreement', async () => {
    const fixture = { ...etymologyFixture, componentsProposal: [], components: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.getByRole('button', { name: 'Propose: It has no parts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'It does have parts' })).toBeInTheDocument();
  });

  it('does not reveal the picker until the reviewer says there ARE parts', async () => {
    const fixture = { ...etymologyFixture, componentsProposal: [], components: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByLabelText('Component picker')).not.toBeInTheDocument();
  });

  it('hides the note from a volunteer entirely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByRole('button', { name: 'Curator tools' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
    // The component search is no longer curator-only: it is how a volunteer says what
    // the parts ARE. It is just not shown until they say there are any.
    expect(screen.queryByPlaceholderText('Search for a part...')).not.toBeInTheDocument();
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
    await openCuratorTools(userEvent.setup());

    const draft = screen.getByLabelText('Draft components');
    // The word, not its word_id. A list loaded from the record used to fall back to printing the
    // id, because labels were only ever populated by an interactive pick; componentsOnRecord now
    // carries the spelling, so a recorded list reads the same way a freshly picked one does.
    expect(draft).toHaveTextContent('fixturegenconfirmed_partspelling');
    expect(draft).not.toHaveTextContent('fixturegenconfirmed_part_word');
  });

  it('starts with an empty manual draft for an atomic word (no self-referencing chip)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await openCuratorTools(userEvent.setup());

    // No chip list at all, rather than a "No components picked yet." placeholder,
    // and no Save button until something is actually picked - saving an empty
    // custom list asserted "these are the parts" about nothing.
    expect(screen.queryByLabelText('Draft components')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save these parts' })).not.toBeInTheDocument();
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
      if (url.includes('/kaikki-search')) return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await openCuratorTools(user);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText(/manual spelling/));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const draft = screen.getByLabelText('Draft components');
    expect(draft).toHaveTextContent('manual spelling');

    await user.click(screen.getByRole('button', { name: 'Save these parts' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Saved these parts: manual spelling');
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

    await openCuratorTools(user);
    expect(screen.getByLabelText('Draft components')).toHaveTextContent('fixturegenconfirmed_partspelling');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.queryByLabelText('Draft components')).not.toBeInTheDocument();
  });

  describe('what WE hold, and where it differs from upstream', () => {
    /** Our breakdown on record, with upstream proposing whatever the caller says. */
    const withRecord = (proposal: Array<Record<string, unknown>>) => ({
      ...etymologyConfirmedFixture,
      componentsProposal: proposal,
      components: ['a_word', 'b_word'],
      componentsOnRecord: [
        { wordId: 'a_word', displayText: 'ojú' },
        { wordId: 'b_word', displayText: 'ilé' },
      ],
    });

    const renderWith = async (fixture: unknown) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));
      render(<EtymologyReview wordId="fixturegenconfirmed_compound_word" isCurator={true} />);
      await waitFor(() => screen.getByText('fixturegenconfirmed_compoundspelling'));
    };

    it('shows our recorded breakdown without being asked to claim the word has parts', async () => {
      // The gap this closes: a curator who entered the parts on Add Word came here and read
      // "Wiktionary suggests no breakdown for this word", because the only list on screen was
      // upstream's. Ours was reachable only by clicking "It does have parts" - i.e. by claiming
      // the word has parts in order to find out it was already recorded as having them.
      await renderWith(withRecord([]));

      const onRecord = screen.getByLabelText('Components on record');
      expect(onRecord).toHaveTextContent('ojú');
      expect(onRecord).toHaveTextContent('ilé');
      expect(screen.queryByLabelText('Component picker')).toBeNull();
    });

    it('says the record is not yet confirmed, which is a different state from absent', async () => {
      await renderWith(withRecord([]));
      expect(screen.getByLabelText('Components on record')).toHaveTextContent('not yet confirmed');
    });

    it('makes confirming OURS the primary action, not accepting upstream', async () => {
      // Precedence: our record is the thing under review and upstream's is the alternative to it.
      await renderWith(
        withRecord([
          { kaikkiForm: 'ọwọ́', wordId: 'c_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
          { kaikkiForm: 'ẹsẹ̀', wordId: 'd_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
        ]),
      );

      expect(screen.getByRole('button', { name: /Confirm ours/ })).toHaveClass('btn-primary');
      expect(screen.getByRole('button', { name: /Accept proposed components/ })).toHaveClass('btn-secondary');
    });

    it('names the disagreement instead of leaving two lists to be diffed by eye', async () => {
      await renderWith(
        withRecord([
          { kaikkiForm: 'ọwọ́', wordId: 'c_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
          { kaikkiForm: 'ẹsẹ̀', wordId: 'd_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
        ]),
      );

      const alert = screen.getByLabelText('Sources disagree');
      expect(alert).toHaveTextContent('ojú + ilé');
      expect(alert).toHaveTextContent('ọwọ́ + ẹsẹ̀');
      // Both actions survive it: upstream is often right and occasionally wrong, and nothing in
      // the data says which.
      expect(screen.getByRole('button', { name: /Confirm ours/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Accept proposed components/ })).toBeInTheDocument();
    });

    it('stays quiet when the two agree, including about order', async () => {
      await renderWith(
        withRecord([
          { kaikkiForm: 'ojú', wordId: 'a_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
          { kaikkiForm: 'ilé', wordId: 'b_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
        ]),
      );
      expect(screen.queryByLabelText('Sources disagree')).toBeNull();
      expect(screen.getByRole('button', { name: /Confirm components/ })).toBeInTheDocument();
    });

    it('treats a reordering as a disagreement, because a decomposition is a sequence', async () => {
      // `ojú + ilé` is not `ilé + ojú`. A set comparison would call these the same answer.
      await renderWith(
        withRecord([
          { kaikkiForm: 'ilé', wordId: 'b_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
          { kaikkiForm: 'ojú', wordId: 'a_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
        ]),
      );
      expect(screen.getByLabelText('Sources disagree')).toBeInTheDocument();
    });

    it('does not call an unresolvable proposal a disagreement', async () => {
      // A proposal naming a word we do not hold is an unresolved suggestion, not a rival answer -
      // and it cannot be accepted anyway, so presenting it as a conflict would ask for a choice
      // that has only one available side.
      await renderWith(
        withRecord([
          { kaikkiForm: 'adìyẹ', wordId: null, ambiguous: false, possibleMatches: [], previewGlosses: [] },
          { kaikkiForm: 'ojú', wordId: 'a_word', ambiguous: false, possibleMatches: [], previewGlosses: [] },
        ]),
      );
      expect(screen.queryByLabelText('Sources disagree')).toBeNull();
    });

    it('shows no record section for an atomic word', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));
      render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
      await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

      expect(screen.queryByLabelText('Components on record')).toBeNull();
    });
  });

  it("shows Wiktionary's prose etymology, in one wording whether or not there is a breakdown", async () => {
    // Two variants used to exist - one framed as a warning ("No structured breakdown exists for
    // this word"), one as a supplement. The warning was scolding the reader about our data: most
    // words have no structured breakdown, and that is not a problem with the word.
    for (const [fixture, wordId, spelling] of [
      [{ ...etymologyConfirmedFixture, componentsProposal: [], etymologyText: 'Clipping of an older form.' }, 'fixturegenconfirmed_compound_word', 'fixturegenconfirmed_compoundspelling'],
      [{ ...etymologyFixture, etymologyText: 'Clipping of an older form.' }, 'fixturegen2_compound_madeupword', 'fixturegen2_compoundspelling'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));
      render(<EtymologyReview wordId={wordId} isCurator={true} />);
      await waitFor(() => screen.getByText(spelling));

      const note = screen.getByLabelText('Kaikki etymology note');
      expect(note).toHaveTextContent('Wiktionary also describes where this word comes from');
      expect(note).toHaveTextContent('Clipping of an older form.');
      expect(note.className).not.toContain('warning-banner');
      cleanup();
    }
  });

  it('does not render a Kaikki etymology note section when there is none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByLabelText('Kaikki etymology note')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // A phrase decomposes into its words, each one a specific etymology
  // -------------------------------------------------------------------------
  // A phrase used to get the word screen, which is nonsense: diagnoseEntry short-circuits phrases so
  // every proposal is empty, which made the heading read "Does this word break into parts?" and
  // offered "It has no parts" - about an object whose identity IS its parts. Our one real phrase,
  // `ẹ jọ̀ọ́`, has zero component rows while its own citation reason says its identity comes from
  // them.

  const phraseFixture = {
    ...etymologyFixture,
    displayText: 'ẹ jọ̀ọ́',
    syllables: ['ẹ', 'jọ̀', 'ọ́'],
    entryType: 'phrase' as const,
    componentsProposal: [],
    components: [],
  };

  it('asks a phrase which words it is made of, and never whether it has parts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => phraseFixture }));
    render(<EtymologyReview wordId="e_joo_please" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('What this task is'));

    expect(screen.getByRole('heading', { name: 'Which words is this phrase made of?' })).toBeInTheDocument();
    // Neither is an available answer about a phrase.
    expect(screen.queryByRole('button', { name: /has no parts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject this etymology/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/single indivisible word/)).not.toBeInTheDocument();
  });

  it('opens the picker for a phrase without being asked, because linking the words IS the task', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => phraseFixture }));
    render(<EtymologyReview wordId="e_joo_please" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('What this task is'));

    // A word hides the picker until the reviewer says there are parts; a phrase has no such question.
    expect(screen.getByLabelText('Component picker')).toBeInTheDocument();
    expect(screen.getByLabelText('Phrase with no words linked')).toHaveTextContent('ẹ jọ̀ọ́');
  });

  it('explains a phrase in terms of its words, and still makes the etymology-not-spelling point', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => phraseFixture }));
    render(<EtymologyReview wordId="e_joo_please" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('What this task is'));

    const explanation = screen.getByLabelText('What this task is');
    expect(explanation).toHaveTextContent('A phrase is made of words');
    expect(explanation).toHaveTextContent('placenta');
  });

  it("names a requested word as pending but does NOT block saving - the locked 'prompt, don't gate' decision", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => phraseFixture });
      if (url.includes('/vocab-search')) return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      if (url.includes('/kaikki-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                form: 'jọ̀ọ́',
                pos: 'particle',
                glosses: ['please'],
                matchedVia: 'yoruba_exact',
                altOfTargets: [],
                standardForms: ['jọ̀ọ́'],
                entryId: 'en-joo-yo-particle-ABC1',
                etymologyNumber: '1',
              },
            ],
          }),
        });
      }
      if (url === '/api/component-requests') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ wordId: 'joo_please', outcome: 'requested', displayText: 'jọ̀ọ́', contributionId: 'c1' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="e_joo_please" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('What this task is'));

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByLabelText('Component search results'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByLabelText('Words awaiting approval')).toBeInTheDocument());
    expect(screen.getByLabelText('Words awaiting approval')).toHaveTextContent('You can still save');

    // And saving genuinely works with a word still pending.
    await user.click(screen.getByRole('button', { name: 'Propose: Save these parts' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/api/contributions');
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        axis: 'etymology',
        componentsAction: 'custom',
        components: ['joo_please'],
      });
    });
  });

  // -------------------------------------------------------------------------
  // A single root is not a decomposition
  // -------------------------------------------------------------------------

  it('offers nothing to accept when Wiktionary derives the word from one root', async () => {
    // 9 of the 21 words with any proposal have exactly one candidate (`ọba → ba`, `ẹwà → wà`).
    // Accepting one would assert a word is composed of ONE word.
    const fixture = {
      ...etymologyFixture,
      components: [],
      componentsProposal: [
        { kaikkiForm: 'ba', wordId: 'ba_word', ambiguous: false, possibleMatches: [], previewGlosses: ['to hide'] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));
    render(<EtymologyReview wordId="oba_king" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByRole('button', { name: /Accept proposed components/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Single root note')).toHaveTextContent('not a breakdown into parts');
    // The honest answers remain available.
    expect(screen.getByRole('button', { name: 'Propose: It has no parts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'It does have parts' })).toBeInTheDocument();
  });

  it('still offers accept when there are two or more parts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => etymologyFixture }));
    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.getByRole('button', { name: 'Propose: Accept proposed components' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Single root note')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // The reverse direction is gone
  // -------------------------------------------------------------------------

  it('renders no "Used in" section at all, for any fixture', async () => {
    // It was never actionable here - applyEtymologyDecision writes component rows only for the word
    // under review - and once the request flow landed, the shared row component told the reader to
    // add such a word as a PART of this one, recording the inverse relationship.
    for (const fixture of [etymologyFixture, etymologyConfirmedFixture, phraseFixture]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fixture }));
      render(<EtymologyReview wordId="w" isCurator={true} />);
      await waitFor(() => screen.getByLabelText('Etymology review'));

      expect(screen.queryByText(/Used in/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Used in proposals')).not.toBeInTheDocument();
      expect(screen.queryByText(/Already confirmed as used in/)).not.toBeInTheDocument();
      expect(screen.queryByText(/No confirmed relationships yet/)).not.toBeInTheDocument();
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // The picker searches the whole corpus, so a missing part is not a dead end
  // -------------------------------------------------------------------------
  // The reported case: `abo adìyẹ`. Wiktionary proposes `abo` + `adìyẹ`, `adìyẹ` was not in the
  // dictionary, and the only offered answer - "Accept proposed components" - could only reply
  // "Can't accept yet", because accepting submits word_ids and one of them did not exist.

  /** A word with a two-part proposal where the second part resolves to nothing. */
  const partlyUnresolvedFixture = {
    ...etymologyFixture,
    components: [],
    componentsProposal: [
      { kaikkiForm: 'abo', wordId: 'abo_female', ambiguous: false, possibleMatches: [], previewGlosses: ['female'] },
      { kaikkiForm: 'adìyẹ', wordId: null, ambiguous: false, possibleMatches: [], previewGlosses: ['chicken'] },
    ],
  };

  const ADIYE_KAIKKI_RESULT = {
    form: 'adìyẹ',
    pos: 'noun',
    glosses: ['chicken'],
    matchedVia: 'yoruba_exact',
    altOfTargets: [],
    standardForms: ['adìyẹ'],
    entryId: 'en-adiye-yo-noun-ABC1',
    etymologyNumber: '1',
  };

  function pickerFetchMock(overrides: Record<string, unknown> = {}) {
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => partlyUnresolvedFixture });
      if (url.includes('/vocab-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { wordId: 'abo_female', displayText: 'abo', syllables: ['a', 'bo'], definition: 'female', baseSpelling: 'abo', matchedVia: 'yoruba_exact' },
            ],
          }),
        });
      }
      if (url.includes('/kaikki-search')) {
        return Promise.resolve({ ok: true, json: async () => ({ results: [ADIYE_KAIKKI_RESULT] }) });
      }
      if (url === '/api/component-requests' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ wordId: 'adiye_chicken', outcome: 'requested', displayText: 'adìyẹ', contributionId: 'c1', ...overrides }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  }

  it('offers building the list instead of an accept that cannot be given, and names what is missing', async () => {
    vi.stubGlobal('fetch', pickerFetchMock());

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));

    expect(screen.queryByRole('button', { name: /Accept proposed components/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build the list of parts' })).toBeInTheDocument();
    expect(screen.getByLabelText('Parts not in the dictionary')).toHaveTextContent('adìyẹ');
  });

  it('pre-seeds the parts that DID resolve, so only the missing one has to be found', async () => {
    vi.stubGlobal('fetch', pickerFetchMock());
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));

    const draft = screen.getByLabelText('Draft components');
    expect(draft).toHaveTextContent('abo');
    expect(draft).not.toHaveTextContent('adìyẹ');
    // And the search is already pointed at the part that is missing.
    expect(screen.getByPlaceholderText('Search for a part...')).toHaveValue('adìyẹ');
  });

  it('lists words we hold before Wiktionary results, and labels which is which', async () => {
    vi.stubGlobal('fetch', pickerFetchMock());
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));

    const results = await waitFor(() => screen.getByLabelText('Component search results'));
    const rows = results.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('in the dictionary');
    expect(rows[1].textContent).toContain('from Wiktionary');
    // WHICH etymology, not just a spelling - the whole reason words enter at etymology-N level.
    expect(rows[1].textContent).toContain('etymology 1');
  });

  it('requests a part we do not hold and lets the volunteer finish the task immediately', async () => {
    const fetchMock = pickerFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));
    await waitFor(() => screen.getByLabelText('Component search results'));

    // Second "Add" is the Wiktionary row; the first is the word we already hold.
    await user.click(screen.getAllByRole('button', { name: 'Add' })[1]);

    const requestCall = fetchMock.mock.calls.find((c) => c[0] === '/api/component-requests');
    expect(requestCall).toBeDefined();
    expect(JSON.parse((requestCall![1] as RequestInit).body as string)).toEqual({
      entryId: 'en-adiye-yo-noun-ABC1',
    });

    // The chip says what is happening, in the word - never the derived word_id.
    await waitFor(() => {
      expect(screen.getByLabelText('Draft components')).toHaveTextContent('will be added once a curator approves');
    });
    expect(screen.getByLabelText('Draft components')).not.toHaveTextContent('adiye_chicken');
    expect(screen.getByRole('status')).toHaveTextContent('has been requested');

    // And the etymology submits NOW, referencing the word_id the request will create. This is
    // the whole point: the task finishes without waiting for a curator.
    await user.click(screen.getByRole('button', { name: 'Propose: Save these parts' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/api/contributions');
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        axis: 'etymology',
        componentsAction: 'custom',
        components: ['abo_female', 'adiye_chicken'],
      });
    });
  });

  it('says nothing about approval when the pick resolves to a word we already hold', async () => {
    // The common case: 55 corpus etymologies derive an id we already use, so picking one has to
    // resolve rather than queue a duplicate - and must not tell the volunteer to wait.
    const fetchMock = pickerFetchMock({ outcome: 'resolved', wordId: 'adiye_chicken', contributionId: undefined });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));
    await waitFor(() => screen.getByLabelText('Component search results'));
    await user.click(screen.getAllByRole('button', { name: 'Add' })[1]);

    await waitFor(() => {
      expect(screen.getByLabelText('Draft components')).toHaveTextContent('adìyẹ');
    });
    expect(screen.getByLabelText('Draft components')).not.toHaveTextContent('will be added once a curator approves');
  });

  it('surfaces a failed request instead of silently dropping the pick', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => partlyUnresolvedFixture });
      if (url.includes('/vocab-search')) return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      if (url.includes('/kaikki-search')) return Promise.resolve({ ok: true, json: async () => ({ results: [ADIYE_KAIKKI_RESULT] }) });
      if (url === '/api/component-requests' && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'entry_id is not citable' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));
    await waitFor(() => screen.getByLabelText('Component search results'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('entry_id is not citable');
    });
    // Nothing added, so the volunteer cannot submit a component that was never requested.
    expect(screen.getByLabelText('Draft components')).not.toHaveTextContent('adìyẹ');
  });

  // -------------------------------------------------------------------------
  // The part that is in neither our dictionary nor Wiktionary
  // -------------------------------------------------------------------------

  async function openUnlistedBranch(user: ReturnType<typeof userEvent.setup>) {
    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));
    await user.click(screen.getByRole('button', { name: "It isn't in Wiktionary either" }));
  }

  it('keeps the no-Wiktionary branch behind an explicit choice, with the preferred route stated', async () => {
    vi.stubGlobal('fetch', pickerFetchMock());
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={false} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    await user.click(screen.getByRole('button', { name: 'Build the list of parts' }));

    // Not stumbled into - the rare path has to be chosen.
    expect(screen.queryByLabelText('Request a word with no Wiktionary entry')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "It isn't in Wiktionary either" }));

    const branch = screen.getByLabelText('Request a word with no Wiktionary entry');
    expect(branch).toHaveTextContent('The preferred route is to ask a curator to add it to Wiktionary first');
  });

  it('writes the word with the composer and no audio, and refuses to submit half of it', async () => {
    vi.stubGlobal('fetch', pickerFetchMock());
    const user = userEvent.setup();
    await openUnlistedBranch(user);

    // The same composer the example axis uses - the six letters no phone keyboard offers, and
    // tone on a grid rather than typed accents.
    expect(screen.getByLabelText('Phrase composer')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Yoruba letters' })).toBeInTheDocument();
    // A request for a dictionary entry, not a pronunciation.
    expect(screen.queryByRole('button', { name: /Record/ })).not.toBeInTheDocument();

    const submitButton = screen.getByRole('button', { name: 'Request this word' });
    expect(submitButton).toBeDisabled();

    await user.type(screen.getByLabelText('The word, written correctly'), 'adiy');
    await user.click(screen.getByRole('button', { name: 'ẹ' }));
    expect(screen.getByLabelText('The word, written correctly')).toHaveValue('adiyẹ');
    // Still not enough: a word with no meaning cannot be reviewed.
    expect(submitButton).toBeDisabled();

    await user.type(screen.getByLabelText('What does it mean in English?'), 'chicken');
    expect(submitButton).toBeEnabled();
  });

  it('submits the request and adds it to the draft as pending, so the task still finishes', async () => {
    const fetchMock = pickerFetchMock({ wordId: 'adiye_chicken', displayText: 'adiyẹ' });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    await openUnlistedBranch(user);

    await user.type(screen.getByLabelText('The word, written correctly'), 'adiyẹ');
    await user.type(screen.getByLabelText('What does it mean in English?'), 'chicken');
    await user.click(screen.getByRole('button', { name: 'Request this word' }));

    const requestCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/component-requests');
      expect(call).toBeDefined();
      return call!;
    });
    // No entryId - that is the whole difference, and the server turns it into an exempt citation.
    expect(JSON.parse((requestCall[1] as RequestInit).body as string)).toEqual({
      displayText: 'adiyẹ',
      definition: 'chicken',
    });

    // Collapses back to the picker with the word in the draft, pending approval.
    await waitFor(() => {
      expect(screen.getByLabelText('Draft components')).toHaveTextContent('will be added once a curator approves');
    });
    expect(screen.queryByLabelText('Request a word with no Wiktionary entry')).not.toBeInTheDocument();
  });

  it('shows a refusal in place rather than losing what was typed', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/etymology')) return Promise.resolve({ ok: true, json: async () => partlyUnresolvedFixture });
      if (url.includes('-search')) return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      if (url === '/api/component-requests' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: 'a word with this spelling and meaning is already in the dictionary' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    await openUnlistedBranch(user);

    await user.type(screen.getByLabelText('The word, written correctly'), 'adiyẹ');
    await user.type(screen.getByLabelText('What does it mean in English?'), 'chicken');
    await user.click(screen.getByRole('button', { name: 'Request this word' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('already in the dictionary');
    });
    // The branch stays open with the text intact - a 409 here means "go and search for it", and
    // retyping the word to do that is pure loss.
    expect(screen.getByLabelText('The word, written correctly')).toHaveValue('adiyẹ');
  });

  it('cancelling clears what was typed and returns to the picker', async () => {
    vi.stubGlobal('fetch', pickerFetchMock());
    const user = userEvent.setup();
    await openUnlistedBranch(user);

    await user.type(screen.getByLabelText('The word, written correctly'), 'adiyẹ');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Request a word with no Wiktionary entry')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "It isn't in Wiktionary either" }));
    expect(screen.getByLabelText('The word, written correctly')).toHaveValue('');
  });

  it('renders two composers on one screen without duplicate ids (the id-prop regression)', async () => {
    // PhraseComposer hardcoded id="phrase-field" when there was one composer in the app. A second
    // one made getByLabelText ambiguous, which reads as a baffling test failure rather than as
    // the real bug.
    vi.stubGlobal('fetch', pickerFetchMock());
    const user = userEvent.setup();
    await openUnlistedBranch(user);

    const { container } = render(
      <PhraseComposer id="second-composer" value="" onChange={() => {}} label="Another phrase" />,
    );
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids).toContain('second-composer-field');
    expect(screen.getByLabelText('The word, written correctly')).toBeInTheDocument();
    expect(screen.getByLabelText('Another phrase')).toBeInTheDocument();
  });

  it('lets a curator search Kaikki and create a missing proposed component inline, then refreshes the proposal', async () => {
    const missingComponentFixture = {
      ...etymologyFixture,
      componentsProposal: [
        {
          kaikkiForm: 'fixturegen2_missingpart',
          wordId: null,
          targetSpellingConfirmed: false,
          ambiguous: false,
          possibleMatches: [],
          provenance: 'etymology_template',
          previewGlosses: ['a missing part'],
          previewGlossesAreExactMatches: true,
        },
      ],
    };
    const resolvedFixture = {
      ...missingComponentFixture,
      componentsProposal: [{ ...missingComponentFixture.componentsProposal[0], wordId: 'fixturegen2_missingpart_newword' }],
    };
    let etymologyCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/etymology')) {
        etymologyCallCount++;
        return Promise.resolve({ ok: true, json: async () => (etymologyCallCount === 1 ? missingComponentFixture : resolvedFixture) });
      }
      if (url.includes('/kaikki-search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                form: 'fixturegen2_missingpart',
                pos: 'noun',
                glosses: ['a missing part'],
                matchedVia: 'yoruba_exact',
                altOfTargets: [],
                standardForms: ['fixturegen2_missingpart'],
                entryId: 'en-fix-yo-noun-MISSING1',
                etymologyNumber: '1',
              },
            ],
          }),
        });
      }
      if (url === '/api/words' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ wordId: 'fixturegen2_missingpart_newword' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<EtymologyReview wordId="fixturegen2_compound_madeupword" isCurator={true} />);
    await waitFor(() => screen.getByText('fixturegen2_compoundspelling'));
    // The reader's words, not the table's - `not in golden_record yet` named a database table.
    expect(screen.getByText(/not in the dictionary yet/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add "fixturegen2_missingpart" to vocabulary' }));
    await waitFor(() => screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    const hintField = screen.getByLabelText('Word ID hint (English meaning)');
    await user.type(hintField, 'missing part');

    await user.click(screen.getByRole('button', { name: 'Add & use as component' }));

    const createCall = fetchMock.mock.calls.find((c) => c[0] === '/api/words' && c[1]?.method === 'POST');
    expect(createCall).toBeDefined();
    const createBody = JSON.parse(createCall![1].body);
    expect(createBody).toMatchObject({
      wordId: 'fixturegen2_missingpart_missing_part',
      displayText: 'fixturegen2_missingpart',
      // The compound case: the component records WHICH etymology it is, so the
      // derived word references one meaning rather than an ambiguous spelling.
      citation: { entryId: 'en-fix-yo-noun-MISSING1' },
    });

    // Refetches the whole review after creating the word - the proposal
    // now resolves to the freshly-created word_id.
    await waitFor(() => {
      // Resolved is now stated in the reader's terms, not as an arrow to a word_id.
      expect(screen.getByText(/already in the dictionary/)).toBeInTheDocument();
    });
    expect(etymologyCallCount).toBe(2);
  });
});

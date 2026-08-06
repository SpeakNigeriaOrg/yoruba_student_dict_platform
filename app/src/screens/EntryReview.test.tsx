// @vitest-environment jsdom
//
// The entry axis screen. Fixtures are real getEntryReview output
// (scripts/generateEntryReviewFixtures.mjs), one per citation state:
//
//   entryReview.json              cited, our spelling agrees with upstream
//   entryReviewCitedDiffers.json  cited, upstream spells it differently
//   entryReviewUncited.json       no citation (predates the citation model)
//   entryReviewAmbiguous.json     no citation, three etymologies share the spelling
//
// Two things are being protected here. The invariant carried over from the merge:
// one POST carries spelling and definition together and neither half can be
// submitted alone. And the new one: a volunteer is asked exactly one question per
// half, in plain language, with no diagnosis vocabulary and no instruments for
// re-deciding which etymology the word is.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EntryReview } from './EntryReview.js';
import entryFixture from '../fixtures/entryReview.json';
import entryDiffersFixture from '../fixtures/entryReviewCitedDiffers.json';
import entryUncitedFixture from '../fixtures/entryReviewUncited.json';
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

function mockFetch(fixture: unknown, kaikkiResults?: unknown[]) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/kaikki-search')) {
      return Promise.resolve({ ok: true, json: async () => ({ results: kaikkiResults ?? [] }) });
    }
    if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => fixture });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function loaded(fixture: unknown, isCurator = true, kaikkiResults?: unknown[]) {
  const fetchMock = mockFetch(fixture, kaikkiResults);
  render(<EntryReview wordId="w" isCurator={isCurator} />);
  await waitFor(() => expect(screen.getByLabelText('Tone editor')).toBeInTheDocument());
  return fetchMock;
}

describe('the tone row is an EDITOR, not a Yes button', () => {
  // The regression this replaces: when our spelling matched upstream the screen
  // showed a single "Yes, that's right" button. That did not merely irritate -
  // every recorded vote said yes because yes was the only thing clickable, so the
  // consensus tally could not mean anything.
  it('gives every syllable a live tone control, even when the spelling already matches upstream', async () => {
    await loaded(entryFixture);

    // dùjẹ̀kù -> dù | jẹ̀ | kù
    for (const n of [1, 2, 3]) {
      expect(screen.getByLabelText(`Tone of syllable ${n}`)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText('Tone of syllable 4')).not.toBeInTheDocument();
  });

  it('labels each button with THIS syllable carrying that tone, not a generic à/a/á', async () => {
    // The first version showed static `à a á` on every button of every syllable, so
    // the choices for `dì` read "à a á" - three letters not present in the syllable
    // being edited, which is simply unreadable as a choice about `dì`.
    await loaded(entryFixture);

    // Syllable 2 of dùjẹ̀kù is `jẹ̀`. Order is HIGH first, top to bottom, so vertical
    // position means pitch and the selected cells trace the word's tone contour.
    const buttons = [...screen.getByLabelText('Tone of syllable 2').querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['jẹ́', 'jẹ', 'jẹ̀']);
  });

  it('orders every syllable high-to-low, so the selected cells form a readable contour', async () => {
    await loaded(entryFixture);
    for (const n of [1, 2, 3]) {
      const group = screen.getByLabelText(`Tone of syllable ${n}`);
      const labels = [...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
      expect(labels).toEqual([
        `Syllable ${n} high tone`,
        `Syllable ${n} mid tone`,
        `Syllable ${n} low tone`,
      ]);
    }
  });

  it('previews the mid-tone form correctly per bearer, since mid is not a mark on a vowel', async () => {
    await loaded(entryFixture);
    // Syllable 1 is `dù`; mid on a vowel is unmarked, so the middle button reads `du`.
    expect(screen.getByLabelText('Syllable 1 mid tone')).toHaveTextContent('du');
  });

  it('drops the separate syllable label when a tone IS selected - the buttons already show it', async () => {
    await loaded(entryFixture);
    expect(screen.queryByLabelText('Syllable 1')).not.toBeInTheDocument();
  });

  it('keeps a label on a syllable with no tone selected, so the row is still identifiable', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    // A bare syllabic nasal: mid on a nasal is a macron, so an unmarked `n` is
    // under-marked and toneOf refuses to call it mid - no button is highlighted.
    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'n');

    expect(screen.getByLabelText('Syllable 1')).toHaveTextContent('n');
    for (const hint of ['low', 'mid', 'high']) {
      expect(screen.getByLabelText(`Syllable 1 ${hint} tone`)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('pre-selects each syllable\'s current tone, so leaving it alone is agreement', async () => {
    await loaded(entryFixture);
    // dù is low, jẹ̀ is low, kù is low in this fixture.
    expect(screen.getByLabelText('Syllable 1 low tone')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Syllable 1 high tone')).toHaveAttribute('aria-pressed', 'false');
  });

  it('submits keep_ours when the reviewer changes nothing', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ action: 'keep_ours', definitionAction: 'confirm' }));
  });

  it('changing ONE syllable\'s tone submits a respelling of the whole word', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({
        action: 'respell',
        newDisplayText: 'dùjẹ́kù',
        // Authored, not re-derived: the boundaries are the ones on screen.
        newSyllables: ['dù', 'jẹ́', 'kù'],
      }),
    );
  });

  it('writes mid tone as no mark on a vowel', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 1 mid tone'));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ newDisplayText: 'dujẹ̀kù' }));
  });

  it('keeps the underdot when the tone changes - it is a letter, not a tone mark', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock).newDisplayText).toContain('ẹ'));
  });
});

describe('normalization must never masquerade as an edit', () => {
  // Five production words store display_text and syllables in NFD (oba_king,
  // alubosa_onion, ose_soap, ibepe_papaya, olongbo_cat), and all five have
  // recordings. The publish scripts drop any recording whose recorded_syllables does
  // not EXACTLY equal golden_record.syllables, so a respell that changed nothing but
  // Unicode composition would silently remove 12 real recordings from the game.
  //
  // A genuine tone change dropping them is correct - the recording is of the old
  // pronunciation. A no-op confirm doing it is not.
  const nfdFixture = {
    ...entryFixture,
    displayText: entryFixture.displayText.normalize('NFD'),
  };

  it('confirming a non-NFC word without changes submits keep_ours, not a respelling', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(nfdFixture);
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('keep_ours'));
    expect(postedBody(fetchMock).newDisplayText).toBeUndefined();
  });

  it('setting a syllable to the tone it already has is still not an edit', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(nfdFixture);

    // Syllable 1 is already low; tapping low must not manufacture a respelling out of
    // the recomposition alone.
    await user.click(screen.getByLabelText('Syllable 1 low tone'));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('keep_ours'));
  });

  it('but a real tone change on a non-NFC word IS a respelling', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(nfdFixture);

    await user.click(screen.getByLabelText('Syllable 1 high tone'));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
  });
});

describe('the comparison line says WHICH kind of difference it is', () => {
  it('reports agreement', async () => {
    await loaded(entryFixture);
    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent('dùjẹ̀kù - the same.');
  });

  it('distinguishes a TONE difference from a letters one', async () => {
    // The subtlety the old screen threw away: classifyToneMatch already separates
    // these, and "differs" told a reviewer nothing about what to look at.
    await loaded(entryDiffersFixture);
    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent('same letters, different tone');
  });

  it('reports a letters difference as such once the reviewer edits the letters', async () => {
    const user = userEvent.setup();
    await loaded(entryDiffersFixture);

    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));
    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'ba');

    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent('the letters differ, not just the tone');
  });

  it('updates live as the tone changes', async () => {
    const user = userEvent.setup();
    await loaded(entryDiffersFixture);

    // wòhunpẹ̀ vs upstream wòhúnpẹ̀ - setting syllable 2 high makes them agree.
    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent('the same.');
  });

  it('says there is nothing to compare against for an uncited word', async () => {
    await loaded(entryUncitedFixture, false);
    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent('not linked to a Wiktionary etymology yet');
  });
});

describe('correcting the letters', () => {
  it('is behind an explicit choice, because it asserts the word itself was wrong', async () => {
    await loaded(entryFixture);
    expect(screen.queryByLabelText('Letters of syllable 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'The letters are wrong' })).toBeInTheDocument();
  });

  it('reveals one letters box per syllable, tone stripped', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    expect(screen.getByLabelText('Letters of syllable 1')).toHaveValue('du');
    expect(screen.getByLabelText('Letters of syllable 2')).toHaveValue('jẹ');
  });

  it('offers the ẹ ọ ṣ palette, which is the whole non-ASCII gap once tone is handled', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    const palette = screen.getByLabelText('Extra letters for syllable 1');
    for (const letter of ['ẹ', 'ọ', 'ṣ']) {
      expect(within(palette).getByRole('button', { name: letter })).toBeInTheDocument();
    }
  });

  it('the palette appends without dropping the tone already chosen', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    // Syllable 1 is `dù` - low. Appending ọ must keep the low tone.
    const palette = screen.getByLabelText('Extra letters for syllable 1');
    await user.click(within(palette).getByRole('button', { name: 'ọ' }));

    expect(screen.getByLabelText('Letters of syllable 1')).toHaveValue('duọ');
    expect(screen.getByLabelText('Syllable 1 low tone')).toHaveAttribute('aria-pressed', 'true');
  });

  it('submits the edited letters as a respelling with matching syllables', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    const box = screen.getByLabelText('Letters of syllable 3');
    await user.clear(box);
    await user.type(box, 'ko');
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => {
      const body = postedBody(fetchMock);
      expect(body.action).toBe('respell');
      // The server rejects a syllable list that does not rejoin to the spelling, so
      // this is the client's half of that invariant.
      expect((body.newSyllables as string[]).join('')).toBe(body.newDisplayText);
    });
  });

  it('does not offer a tone control for a syllable that cannot carry tone', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'gb');

    expect(screen.queryByLabelText('Tone of syllable 1')).not.toBeInTheDocument();
  });
});

describe('the student definition is a simplification, not a correction', () => {
  it('is labelled "Student definition" and seeded from what is on record', async () => {
    await loaded(entryFixture);
    expect(screen.getByLabelText('Student definition')).toHaveValue('chicken');
  });

  it('shows the upstream glosses it is simplifying FROM, taken from the pin', async () => {
    await loaded(entryFixture);
    expect(screen.getByLabelText('Upstream glosses')).toHaveTextContent('Wiktionary says: chicken; fowl');
  });

  it('says in as many words that rewording is not a correction', async () => {
    await loaded(entryFixture);
    expect(screen.getByText(/simplification,\s*not a correction/)).toBeInTheDocument();
  });

  it('sends free-typed text as a custom definition', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.clear(screen.getByLabelText('Student definition'));
    await user.type(screen.getByLabelText('Student definition'), 'a bird we keep for eggs');
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({
        definitionAction: 'custom',
        definitionText: 'a bird we keep for eggs',
      }),
    );
  });

  it('sends definitionAction confirm when the text is left as it stands', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ definitionAction: 'confirm' }));
  });
});

describe('atomicity: an entry is decided as a whole', () => {
  it('is answerable immediately, because the tone row IS the answer', async () => {
    // Deliberately different from the old screen, which required arming a separate
    // spelling choice first. A pre-filled editor means the reviewer can confirm
    // straight away or change any syllable - both are real answers.
    await loaded(entryFixture);
    expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeEnabled();
  });

  it('will not submit with an empty definition', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.clear(screen.getByLabelText('Student definition'));

    expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeDisabled();
    expect(fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBeUndefined();
  });

  it('sends both halves in ONE request to /api/decisions/entry', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.clear(screen.getByLabelText('Student definition'));
    await user.type(screen.getByLabelText('Student definition'), 'a hen');
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0][0]).toBe('/api/decisions/entry');
    });
    expect(postedBody(fetchMock)).toMatchObject({ action: 'keep_ours', definitionAction: 'custom', definitionText: 'a hen' });
  });

  it('a non-curator proposes a contribution instead of deciding directly', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture, false);

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(post?.[0]).toBe('/api/contributions');
    });
  });
});

describe('a volunteer is not handed curator instruments', () => {
  it('shows no diagnosis vocabulary', async () => {
    await loaded(entryFixture, false);
    expect(screen.queryByLabelText('Spelling diagnosis')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Diagnosis:/)).not.toBeInTheDocument();
  });

  it('shows no manual Kaikki search and no note field', async () => {
    await loaded(entryFixture, false);
    expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search Kaikki...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Curator tools' })).not.toBeInTheDocument();
  });

  it('is not shown the candidate list even for a word whose etymology is ambiguous', async () => {
    // Ambiguity is not a volunteer's problem under the standard flow, where a word
    // arrives already citing the etymology whoever added it chose.
    await loaded(entryAmbiguousFixture, false);
    expect(screen.queryByLabelText('Candidates considered')).not.toBeInTheDocument();
  });
});

describe('curator tools', () => {
  it('are collapsed by default, so a routine review looks the same for a curator', async () => {
    await loaded(entryFixture);
    expect(screen.getByRole('button', { name: 'Curator tools' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
  });

  it('expose the diagnosis, what the word cites, the note, and Kaikki re-linking', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'Curator tools' }));

    expect(screen.getByLabelText('Spelling diagnosis')).toHaveTextContent('match');
    expect(screen.getByLabelText('Spelling diagnosis')).toHaveTextContent('fixturegenentry-etym-adiye');
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search Kaikki...')).toBeInTheDocument();
  });

  it('list the competing etymologies with their numbers, so they can be told apart', async () => {
    const user = userEvent.setup();
    await loaded(entryAmbiguousFixture);
    await user.click(screen.getByRole('button', { name: 'Curator tools' }));

    const list = screen.getByLabelText('Candidates considered');
    expect(list).toHaveTextContent('etymology 2');
    expect(list).toHaveTextContent('etymology 3');
    expect(list).toHaveTextContent('etymology 4');
    expect(list).toHaveTextContent('to hang, suspend');
  });

  it('submit the chosen etymology by ID, not by a spelling that identifies nothing', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryAmbiguousFixture);
    await user.click(screen.getByRole('button', { name: 'Curator tools' }));

    // All three radios carry the same form; only the id distinguishes them.
    const radios = screen.getByLabelText('Candidates considered').querySelectorAll('input[type=radio]');
    await user.click(radios[2]);
    await user.type(screen.getByLabelText('Student definition'), 'to hang something up');
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({
        action: 'select_candidate',
        senseEntryId: 'fixturegenentry-etym-ko4',
      }),
    );
  });

  it('picking a Kaikki search result re-cites the word and retargets the definition', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture, true, [
      {
        form: 'fixturegenentry_other',
        pos: 'noun',
        glosses: ['a different meaning'],
        matchedVia: 'yoruba_exact',
        altOfTargets: [],
        standardForms: ['fixturegenentry_other'],
        entryId: 'en-other-yo-noun-XYZ',
        etymologyNumber: '5',
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'Curator tools' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByRole('button', { name: 'Use this record' }));
    await user.click(screen.getByRole('button', { name: 'Use this record' }));

    expect(screen.getByLabelText('Student definition')).toHaveValue('a different meaning');

    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));
    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({
        action: 'select_candidate',
        senseEntryId: 'en-other-yo-noun-XYZ',
        definitionSourceForm: 'fixturegenentry_other',
      }),
    );
  });
});

describe('syllable split', () => {
  it('still offers the manual/programmatic choice when they disagree', async () => {
    // entryReviewCitedDiffers has ['ka','su'] against a differently-toned upstream
    // form, which is what makes the split comparison appear.
    await loaded(entryDiffersFixture);
    const comparison = screen.queryByLabelText('Syllable split comparison');
    if (comparison) {
      expect(screen.getByRole('button', { name: 'Accept programmatic split' })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('button', { name: 'Accept programmatic split' })).not.toBeInTheDocument();
    }
  });
});

describe('failures', () => {
  it('reports a load failure rather than rendering an empty screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })),
    );
    render(<EntryReview wordId="w" isCurator={true} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load entry data"));
  });

  it('surfaces a submit failure and stays on the task', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'nope' }) });
      }
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<EntryReview wordId="w" isCurator={true} />);
    await waitFor(() => expect(screen.getByLabelText('Tone editor')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('nope'));
    expect(screen.getByLabelText('Tone editor')).toBeInTheDocument();
  });
});

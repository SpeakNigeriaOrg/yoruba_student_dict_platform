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

  it('keeps a label on a syllable that cannot carry tone at all, so the row stays identifiable', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    // A consonant-only syllable. NOT a bare nasal: `n` reads as mid, because the macron
    // convention is not universal, so its row is highlighted like any other.
    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'gb');

    expect(screen.getByLabelText('Syllable 1')).toHaveTextContent('gb');
    expect(screen.queryByLabelText('Tone of syllable 1')).not.toBeInTheDocument();
  });

  it('a bare syllabic nasal shows mid selected, not an empty row demanding a choice', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'n');

    expect(screen.getByLabelText('Syllable 1 mid tone')).toHaveAttribute('aria-pressed', 'true');
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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ action: 'keep_ours', definitionAction: 'confirm' }));
  });

  it('changing ONE syllable\'s tone submits a respelling of the whole word', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ newDisplayText: 'dujẹ̀kù' }));
  });

  it('keeps the underdot when the tone changes - it is a letter, not a tone mark', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('keep_ours'));
    expect(postedBody(fetchMock).newDisplayText).toBeUndefined();
  });

  it('setting a syllable to the tone it already has is still not an edit', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(nfdFixture);

    // Syllable 1 is already low; tapping low must not manufacture a respelling out of
    // the recomposition alone.
    await user.click(screen.getByLabelText('Syllable 1 low tone'));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('keep_ours'));
  });

  it('but a real tone change on a non-NFC word IS a respelling', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(nfdFixture);

    await user.click(screen.getByLabelText('Syllable 1 high tone'));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

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

  it('says so when the reviewer has deviated from the record, and from what', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);

    expect(screen.queryByLabelText('Changed from')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    expect(screen.getByLabelText('Changed from')).toHaveTextContent('changed from dùjẹ̀kù');
  });

  it('stops saying so once the reviewer puts it back', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 2 high tone'));
    await user.click(screen.getByLabelText('Syllable 2 low tone'));
    expect(screen.queryByLabelText('Changed from')).not.toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => {
      const body = postedBody(fetchMock);
      expect(body.action).toBe('respell');
      // The server rejects a syllable list that does not rejoin to the spelling, so
      // this is the client's half of that invariant.
      expect((body.newSyllables as string[]).join('')).toBe(body.newDisplayText);
    });
  });

  it('submits a re-split when the reviewer frees an absorbed nasal', async () => {
    // The one correction that was previously unreachable. Tone goes on a syllable's vowel, so the
    // three buttons over `jẹ̀n` never touch its `n` - a reviewer who knew the nasal was its own
    // syllable had no way to say so, and every recorded vote agreed with the default because the
    // default was all there was.
    //
    // `dùjẹ̀nkù` is invented but orthographically real, and verified absent from the corpus, like
    // the rest of these fixtures.
    const nasalFixture = { ...entryFixture, displayText: 'dùjẹ̀nkù', syllables: ['dù', 'jẹ̀n', 'kù'] };
    const user = userEvent.setup();
    const fetchMock = await loaded(nasalFixture);

    await user.click(screen.getByRole('button', { name: 'Make the nasal of syllable 2 its own syllable' }));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => {
      const body = postedBody(fetchMock);
      expect(body.action).toBe('respell');
      // Four, not three - and the macron is what carries that claim into the spelling.
      expect(body.newSyllables).toEqual(['dù', 'jẹ̀', 'n̄', 'kù']);
      expect(body.newDisplayText).toBe('dùjẹ̀n̄kù');
      // The server refuses a list that does not rejoin to the spelling; this is the client's half.
      expect((body.newSyllables as string[]).join('')).toBe(body.newDisplayText);
    });
  });

  it('gives the freed nasal its own tone column, so its tone can then be set', async () => {
    const nasalFixture = { ...entryFixture, displayText: 'dùjẹ̀nkù', syllables: ['dù', 'jẹ̀n', 'kù'] };
    const user = userEvent.setup();
    const fetchMock = await loaded(nasalFixture);

    await user.click(screen.getByRole('button', { name: 'Make the nasal of syllable 2 its own syllable' }));
    // Four columns now, and the nasal is the third.
    await user.click(screen.getByRole('button', { name: 'Syllable 3 low tone' }));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => {
      const body = postedBody(fetchMock);
      expect(body.newSyllables).toEqual(['dù', 'jẹ̀', 'ǹ', 'kù']);
      expect(body.newDisplayText).toBe('dùjẹ̀ǹkù');
    });
  });

  it('offers no nasal control on a word that has none', async () => {
    await loaded(entryFixture);
    expect(screen.queryByRole('button', { name: /its own syllable/ })).not.toBeInTheDocument();
  });

  it('offers a way out: Discard puts the word back as it was when the editor opened', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));
    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'xyz');
    expect(screen.getByLabelText('Letters of syllable 1')).toHaveValue('xyz');

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    // Back to the normal flow, with the word restored.
    expect(screen.queryByLabelText('Letters of syllable 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent('dùjẹ̀kù');

    // And submitting now claims nothing was changed.
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() => expect(postedBody(fetchMock).action).toBe('keep_ours'));
  });

  it('Discard is disabled until something has actually changed', async () => {
    const user = userEvent.setup();
    await loaded(entryFixture);
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));

    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();

    const box = screen.getByLabelText('Letters of syllable 2');
    await user.clear(box);
    await user.type(box, 'ba');

    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
  });

  it('keeps tone choices made BEFORE the letters editor was opened', async () => {
    // The snapshot is taken on open, not on load, so a discard throws away only what
    // happened inside the letters editor - not careful work done before it.
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByLabelText('Syllable 3 high tone'));
    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));
    const box = screen.getByLabelText('Letters of syllable 1');
    await user.clear(box);
    await user.type(box, 'xyz');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({ action: 'respell', newDisplayText: 'dùjẹ̀kú' }),
    );
  });

  it('Done with letters keeps what was typed', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByRole('button', { name: 'The letters are wrong' }));
    const box = screen.getByLabelText('Letters of syllable 3');
    await user.clear(box);
    await user.type(box, 'ko');
    await user.click(screen.getByRole('button', { name: 'Done with letters' }));

    expect(screen.queryByLabelText('Letters of syllable 3')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
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
    expect(screen.getByLabelText('Wiktionary glosses')).toHaveTextContent('Wiktionary says: chicken; fowl');
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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

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

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ definitionAction: 'confirm' }));
  });
});

describe('atomicity: an entry is decided as a whole', () => {
  it('is answerable immediately, because the tone row IS the answer', async () => {
    // Deliberately different from the old screen, which required arming a separate
    // spelling choice first. A pre-filled editor means the reviewer can confirm
    // straight away or change any syllable - both are real answers.
    await loaded(entryFixture);
    expect(screen.getByRole('button', { name: 'Record my answer' })).toBeEnabled();
  });

  it('will not submit with an empty definition', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.clear(screen.getByLabelText('Student definition'));

    expect(screen.getByRole('button', { name: 'Record my answer' })).toBeDisabled();
    expect(fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBeUndefined();
  });

  it('sends both halves in ONE request', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.clear(screen.getByLabelText('Student definition'));
    await user.type(screen.getByLabelText('Student definition'), 'a hen');
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(posts).toHaveLength(1);
    });
    expect(postedBody(fetchMock)).toMatchObject({ action: 'keep_ours', definitionAction: 'custom', definitionText: 'a hen' });
  });

  it('records a CURATOR\'s answer as a contribution, exactly like anyone else\'s', async () => {
    // This reverses the old behaviour deliberately. A curator's Confirm used to POST
    // /decisions/entry and write golden_record on the spot, off one boolean, with the word
    // "entry" on the button as the only sign of which had happened - and a curator had no
    // way to record a mere opinion at all, though the consensus model has always assumed
    // their answer is one vote among others. Deciding is now a separate act in a separate
    // place, where the tally is visible.
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture, true);

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(post?.[0]).toBe('/api/contributions');
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/decisions/'))).toBe(false);
  });

  it('records a volunteer\'s answer the same way, through the same button', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture, false);

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

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

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
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
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('nope'));
    expect(screen.getByLabelText('Tone editor')).toBeInTheDocument();
  });
});

describe('a phrase can be respelled here, because nothing else can respell it', () => {
  // The gap this closes, found by trying to correct a real production phrase. A multi-word
  // spelling makes syllabifySpans return null, so this screen fell to its read-only branch
  // and said the spelling "can only be changed by a curator" - while the route a curator had
  // used, re-deriving the spelling from the components on the etymology axis, had just been
  // removed for being wrong. Nobody could change it, and the screen said otherwise.
  const PHRASE = {
    ...entryFixture,
    wordId: 'fi_sile_leave_alone',
    displayText: 'fi sílẹ̀',
    matchedForm: 'fi sílẹ̀',
    canonicalForm: 'fi sílẹ̀',
    adoptionTarget: 'fi sílẹ̀',
    syllables: ['fi', 'sí', 'lẹ̀'],
    syllableSplitStatus: 'match',
  };

  async function loadedPhrase() {
    const fetchMock = mockFetch(PHRASE);
    render(<EntryReview wordId="fi_sile_leave_alone" isCurator />);
    await waitFor(() => expect(screen.getByLabelText('Phrase composer')).toBeInTheDocument());
    return fetchMock;
  }

  it('offers the composer rather than "only a curator can change this"', async () => {
    await loadedPhrase();
    expect(screen.getByLabelText('The phrase, spelled as it is said')).toHaveValue('fi sílẹ̀');
    expect(screen.queryByText(/can only be changed by a curator/)).not.toBeInTheDocument();
  });

  it('gives each word its own tone grid, since the phrase has no single syllable row', async () => {
    await loadedPhrase();
    // `fi` is one syllable, `sílẹ̀` is two, so the grids are per word rather than per phrase.
    expect(screen.getByLabelText('Tone of syllable 1 of word 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Tone of syllable 2 of word 2')).toBeInTheDocument();
  });

  it('submits a respell whose syllables are the composed text, spaces and all', async () => {
    const fetchMock = await loadedPhrase();
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText('The phrase, spelled as it is said'));
    await user.type(screen.getByLabelText('The phrase, spelled as it is said'), 'fi sile');
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
    const body = postedBody(fetchMock);
    expect(body.newDisplayText).toBe('fi sile');
    // Three syllables across two words, and no space in any of them - a space is
    // orthography, a syllable is a tone-bearing unit. The server's respell check strips
    // whitespace from the spelling before comparing for exactly this reason.
    expect(body.newSyllables).toEqual(['fi', 'si', 'le']);
  });

  it('an untouched phrase is keep_ours, not a respelling of itself', async () => {
    const fetchMock = await loadedPhrase();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() => expect(postedBody(fetchMock).action).toBe('keep_ours'));
  });

  it('still refuses a single word the syllabifier cannot represent', async () => {
    // The read-only branch is not gone, it is just no longer where phrases land. This used to
    // use `gan-an`, which now splits on its hyphen and gets the composer - so the example has to
    // be a form with no syllable model at all, and `شعِ` is a real corpus alternate of `ṣe`.
    mockFetch({ ...entryFixture, displayText: 'شعِ', matchedForm: 'شعِ', canonicalForm: 'شعِ' });
    render(<EntryReview wordId="w" isCurator />);
    await waitFor(() => expect(screen.getByText(/can only be changed by a curator/)).toBeInTheDocument());
    expect(screen.queryByLabelText('Phrase composer')).not.toBeInTheDocument();
  });
});

describe('a hyphenated entry is editable, and its hyphen is a separator', () => {
  // Hyphenated forms used to share the phrase dead end: syllabifySpans refuses anything with a
  // hyphen, so `ilé-ìwé` and `aárùn-ún` landed on the read-only branch that says a curator must
  // fix it. The composer handles them for the same reason it handles a phrase - the pieces
  // between separators are what a tone grid can work on.
  function hyphenated(displayText: string, syllables: string[]) {
    return {
      ...entryFixture,
      displayText,
      matchedForm: displayText,
      canonicalForm: displayText,
      adoptionTarget: displayText,
      syllables,
      syllableSplitStatus: 'match',
    };
  }

  async function loadedWith(fixture: unknown) {
    const fetchMock = mockFetch(fixture);
    render(<EntryReview wordId="w" isCurator />);
    await waitFor(() => expect(screen.getByLabelText('Phrase composer')).toBeInTheDocument());
    return fetchMock;
  }

  it('offers the composer for a compound, one grid per hyphen-part', async () => {
    // `ilé-ìwé` ("school") is ilé + ìwé: the hyphen joins two words.
    await loadedWith(hyphenated('ilé-ìwé', ['i', 'lé', 'ì', 'wé']));
    expect(screen.getByLabelText('The phrase, spelled as it is said')).toHaveValue('ilé-ìwé');
    expect(screen.getByLabelText('Tone of syllable 2 of word 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Tone of syllable 2 of word 2')).toBeInTheDocument();
  });

  it('offers it for an elongated nasal too, where the hyphen is phonological', async () => {
    // `aárùn-ún` is ONE word; the hyphen says where the nasal attaches. Same editing need,
    // different linguistic fact, and the screen does not have to know which.
    await loadedWith(hyphenated('aárùn-ún', ['a', 'á', 'rùn', 'ún']));
    expect(screen.getByLabelText('The phrase, spelled as it is said')).toHaveValue('aárùn-ún');
  });

  it('round-trips the hyphen into the respelling', async () => {
    const fetchMock = await loadedWith(hyphenated('ile-iwe', ['i', 'le', 'i', 'we']));
    const user = userEvent.setup();
    const field = screen.getByLabelText('The phrase, spelled as it is said');
    await user.clear(field);
    await user.type(field, 'ilé-ìwé');
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
    const body = postedBody(fetchMock);
    expect(body.newDisplayText).toBe('ilé-ìwé');
    // The hyphen is in the spelling and in none of the syllables. The server's respell check
    // strips separators from the spelling before comparing, for exactly this shape.
    expect(body.newSyllables).toEqual(['i', 'lé', 'ì', 'wé']);
  });

  it('leaves a form with no syllable model at all on the read-only branch', async () => {
    // `شعِ` is a real corpus alternate spelling of `ṣe`. No piece of it can be represented, so a
    // text box would only let it be mangled.
    mockFetch(hyphenated('شعِ', ['شعِ']));
    render(<EntryReview wordId="w" isCurator />);
    await waitFor(() => expect(screen.getByText(/can only be changed by a curator/)).toBeInTheDocument());
    expect(screen.queryByLabelText('Phrase composer')).not.toBeInTheDocument();
  });
});

describe('linking an etymology must not swallow the spelling that was corrected alongside it', () => {
  // The bug, from a real session on `o ṣe`. A curator opened the entry axis, corrected the tone to
  // `o ṣé` in the composer, then used curator tools to link the Kaikki record - and the tone was
  // gone from every later screen. Nothing had failed: the two answers were resolved with a plain
  // `pick ?? edited`, so the pick won, and `select_candidate` writes no display_text at all. The
  // spelling correction was discarded on the client with the "Reads:" line still showing it.
  //
  // The two are separate questions and land in separate fields - `action` says how it is spelled,
  // `senseEntryId` says which etymology it is - so both belong in the one submission.
  const O_SE = {
    ...entryFixture,
    wordId: 'o_se_thank_you',
    displayText: 'o ṣe',
    matchedForm: 'o ṣe',
    canonicalForm: 'o ṣe',
    syllables: ['o', 'ṣe'],
    syllableSplitStatus: 'match',
    citation: {
      entryId: 'en-o-ṣe-yo-intj-OLD',
      exemptReason: null,
      pin: { pos: 'intj', glosses: ['thank you'], canonicalForm: 'o ṣé', etymologyText: null, etymologyNumber: null },
    },
  };

  const UPSTREAM_RESULT = [
    {
      form: 'o ṣé',
      pos: 'intj',
      glosses: ['thank you (non-honorific, to a singular person)'],
      matchedVia: 'yoruba_exact',
      altOfTargets: [],
      standardForms: ['o ṣé'],
      entryId: 'en-o-ṣe-yo-intj-NEW',
      etymologyNumber: null,
    },
  ];

  it('keeps the respelling AND records the etymology, in one submission', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(O_SE, UPSTREAM_RESULT);
    render(<EntryReview wordId="o_se_thank_you" isCurator />);
    await waitFor(() => expect(screen.getByLabelText('Phrase composer')).toBeInTheDocument());

    // Correct the tone first, exactly as the curator did.
    const field = screen.getByLabelText('The phrase, spelled as it is said');
    await user.clear(field);
    await user.type(field, 'o ṣé');

    // Then link the record.
    await user.click(screen.getByRole('button', { name: 'Curator tools' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByRole('button', { name: 'Use this record' }));
    await user.click(screen.getByRole('button', { name: 'Use this record' }));

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
    expect(postedBody(fetchMock)).toMatchObject({
      action: 'respell',
      newDisplayText: 'o ṣé',
      senseEntryId: 'en-o-ṣe-yo-intj-NEW',
    });
    expect(postedBody(fetchMock).newSyllables).toEqual(['o', 'ṣé']);
  });

  it('does the same for a single word, where the correction comes off the syllable row', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(entryFixture, UPSTREAM_RESULT);
    render(<EntryReview wordId="w" isCurator />);
    await waitFor(() => expect(screen.getByLabelText('Tone editor')).toBeInTheDocument());

    // dùjẹ̀kù -> the first syllable at high tone. Any tone edit is a respell.
    await user.click(screen.getByLabelText('Syllable 1 high tone'));
    await user.click(screen.getByRole('button', { name: 'Curator tools' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByRole('button', { name: 'Use this record' }));
    await user.click(screen.getByRole('button', { name: 'Use this record' }));

    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
    expect(postedBody(fetchMock).senseEntryId).toBe('en-o-ṣe-yo-intj-NEW');
  });

  it('still lets the pick decide on its own when the spelling was left alone', async () => {
    // keep_ours says nothing select_candidate does not say better, so an untouched spelling must
    // not demote the pick to a no-op.
    const user = userEvent.setup();
    const fetchMock = mockFetch(O_SE, UPSTREAM_RESULT);
    render(<EntryReview wordId="o_se_thank_you" isCurator />);
    await waitFor(() => expect(screen.getByLabelText('Phrase composer')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Curator tools' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByRole('button', { name: 'Use this record' }));
    await user.click(screen.getByRole('button', { name: 'Use this record' }));
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));

    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({
        action: 'select_candidate',
        senseEntryId: 'en-o-ṣe-yo-intj-NEW',
      }),
    );
  });

  it('says what Wiktionary has for a phrase, and offers it - which this branch never did', async () => {
    // The pinned canonicalForm was `o ṣé` the whole time. Only the single-word branch rendered the
    // comparison, so on a phrase the right answer sat in the citation, invisible, on the one screen
    // whose job is to settle the spelling.
    const user = userEvent.setup();
    const fetchMock = mockFetch(O_SE);
    render(<EntryReview wordId="o_se_thank_you" isCurator />);
    await waitFor(() => expect(screen.getByLabelText('Phrase composer')).toBeInTheDocument());

    expect(screen.getByLabelText('Spelling comparison')).toHaveTextContent(
      'Wiktionary has o ṣé - same letters, different tone.',
    );

    await user.click(screen.getByRole('button', { name: "Use Wiktionary's spelling" }));
    expect(screen.getByLabelText('The phrase, spelled as it is said')).toHaveValue('o ṣé');

    // Loaded into the composer, not submitted from under the curator - and it travels as a
    // respell, since a phrase has no adopt_kaikki route (diagnoseEntry returns early for one).
    await user.click(screen.getByRole('button', { name: 'Record my answer' }));
    await waitFor(() => expect(postedBody(fetchMock).action).toBe('respell'));
    expect(postedBody(fetchMock).newDisplayText).toBe('o ṣé');
  });
});

// ---------------------------------------------------------------------------
// The danger zone
// ---------------------------------------------------------------------------
// Two operations that act on the entry rather than on a claim about it, and the reason they
// are gated the way they are: a rename is recoverable (rename it back), a delete is not -
// audio lives in Postgres, so nothing restores it.
describe('entry admin', () => {
  const WORD_ID = 'fixturegenentry_adiye_chicken';

  function mockAdminFetch(
    impact: Record<string, unknown>,
    responses: { patch?: { ok: boolean; body: unknown }; delete?: { ok: boolean; body: unknown } } = {},
  ) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const r = responses.patch ?? { ok: true, body: { from: WORD_ID, to: 'renamed_id', moved: [] } };
        return Promise.resolve({ ok: r.ok, json: async () => r.body });
      }
      if (init?.method === 'DELETE') {
        const r = responses.delete ?? { ok: true, body: { deleted: impact } };
        return Promise.resolve({ ok: r.ok, json: async () => r.body });
      }
      if (url.includes('/deletion-impact')) return Promise.resolve({ ok: true, json: async () => impact });
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const EMPTY_IMPACT = {
    wordId: WORD_ID,
    displayText: 'dùjẹ̀kù',
    attached: [],
    attachedTotal: 0,
    usedAsComponentOf: [],
  };

  async function openZone(
    impact: Record<string, unknown>,
    handlers: { onRenamed?: (id: string) => void; onDeleted?: (id: string) => void } = {},
    responses?: Parameters<typeof mockAdminFetch>[1],
  ) {
    const user = userEvent.setup();
    const fetchMock = mockAdminFetch(impact, responses);
    const entryAdmin = {
      onRenamed: handlers.onRenamed ?? vi.fn(),
      onDeleted: handlers.onDeleted ?? vi.fn(),
    };
    render(<EntryReview wordId={WORD_ID} isCurator entryAdmin={entryAdmin} />);
    await waitFor(() => expect(screen.getByLabelText('Tone editor')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Entry admin' }));
    await waitFor(() => expect(screen.getByLabelText('Entry admin')).toBeInTheDocument());
    return { user, fetchMock, entryAdmin };
  }

  it('is absent in the task queue, which passes no entryAdmin', async () => {
    await loaded(entryFixture);
    expect(screen.queryByRole('button', { name: 'Entry admin' })).not.toBeInTheDocument();
  });

  it('is absent for a volunteer even where the screen could navigate', async () => {
    mockAdminFetch(EMPTY_IMPACT);
    render(<EntryReview wordId={WORD_ID} isCurator={false} entryAdmin={{ onRenamed: vi.fn(), onDeleted: vi.fn() }} />);
    await waitFor(() => expect(screen.getByLabelText('Tone editor')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Entry admin' })).not.toBeInTheDocument();
  });

  it('names what a deletion would destroy, item by item', async () => {
    await openZone({
      ...EMPTY_IMPACT,
      attached: [
        { label: 'audio recordings', count: 3 },
        { label: 'images', count: 1 },
      ],
      attachedTotal: 4,
    });

    const banner = screen.getByLabelText('Deletion impact');
    expect(banner).toHaveTextContent('3 audio recordings');
    expect(banner).toHaveTextContent('1 images');
  });

  it('will not delete until the word_id is retyped - a mis-tap cannot reach it', async () => {
    const onDeleted = vi.fn();
    const { user, fetchMock } = await openZone(EMPTY_IMPACT, { onDeleted });

    expect(screen.getByRole('button', { name: 'Delete entry' })).toBeDisabled();
    await user.type(screen.getByLabelText('Confirm word ID'), 'not-the-word');
    expect(screen.getByRole('button', { name: 'Delete entry' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Confirm word ID'));
    await user.type(screen.getByLabelText('Confirm word ID'), WORD_ID);
    await user.click(screen.getByRole('button', { name: 'Delete entry' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(WORD_ID));
    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
    expect(call?.[0]).toBe(`/api/words/${WORD_ID}?confirm=true`);
  });

  it('offers no delete at all for a word other entries are built from, and says which', async () => {
    await openZone({ ...EMPTY_IMPACT, usedAsComponentOf: ['ile_iwe_school', 'ile_ise_workplace'] });

    expect(screen.getByLabelText('Deletion blocked')).toHaveTextContent('ile_iwe_school, ile_ise_workplace');
    expect(screen.queryByRole('button', { name: 'Delete entry' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm word ID')).not.toBeInTheDocument();
  });

  it('renames to the id the server confirms, not the one that was typed', async () => {
    const onRenamed = vi.fn();
    const { user, fetchMock } = await openZone(EMPTY_IMPACT, { onRenamed });

    await user.clear(screen.getByLabelText('New word ID'));
    await user.type(screen.getByLabelText('New word ID'), 'adiye_hen');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ newWordId: 'adiye_hen' });
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('renamed_id'));
  });

  it('cannot rename a word to the id it already has', async () => {
    await openZone(EMPTY_IMPACT);
    expect(screen.getByLabelText('New word ID')).toHaveValue(WORD_ID);
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it("shows the server's own explanation of a bad id rather than pre-judging it", async () => {
    // No client-side regex, deliberately - api/src/handlers/wordIdShape.ts is the single
    // statement of the rule and its message says why the rule exists.
    const { user } = await openZone(
      EMPTY_IMPACT,
      {},
      { patch: { ok: false, body: { error: "word_id 'ọwọ́_hand' must be lowercase a-z, 0-9, underscore and hyphen only" } } },
    );

    await user.clear(screen.getByLabelText('New word ID'));
    await user.type(screen.getByLabelText('New word ID'), 'ọwọ́_hand');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('must be lowercase a-z, 0-9, underscore and hyphen only'),
    );
  });
});

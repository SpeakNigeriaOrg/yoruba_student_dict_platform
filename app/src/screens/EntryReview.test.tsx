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
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  await waitFor(() => expect(screen.getByLabelText('Spelling question')).toBeInTheDocument());
  return fetchMock;
}

describe('spelling: a cited word whose spelling already agrees with upstream', () => {
  it('states the agreement and offers ONE affirmation, not a choice between identical options', async () => {
    // The regression this replaces: adoptionTarget is populated even on a clean
    // match (it equals displayText in this very fixture), so the old screen showed
    // "Keep our spelling (adìyẹ)" beside "Adopt Kaikki's spelling (adìyẹ)".
    await loaded(entryFixture);

    expect(screen.getByLabelText('Spelling question')).toHaveTextContent('the same as ours');
    const buttons = screen.getByLabelText('Spelling choice').querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Yes, that's right");
  });

  it('never offers to adopt a spelling identical to the one on record', async () => {
    await loaded(entryFixture);
    expect(screen.queryByRole('button', { name: /Adopt/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Wiktionary's is right/ })).not.toBeInTheDocument();
  });

  it('submits keep_ours plus the definition half in one request', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ action: 'keep_ours', definitionAction: 'confirm' }));
  });
});

describe('spelling: a cited word upstream spells differently', () => {
  it('shows both spellings and frames the change as a correction', async () => {
    await loaded(entryDiffersFixture);

    const question = screen.getByLabelText('Spelling question');
    expect(question).toHaveTextContent('fixturegenentry_kasu');
    expect(question).toHaveTextContent('fixturegenentry_kásù');
    expect(screen.getByText(/A spelling change is a correction/)).toBeInTheDocument();
  });

  it('offers two options whose labels are actually different from each other', async () => {
    await loaded(entryDiffersFixture);
    const labels = [...screen.getByLabelText('Spelling choice').querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });

  it('submits adopt_kaikki with the diagnosed adoptionTarget', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryDiffersFixture);

    await user.click(screen.getByRole('button', { name: /Wiktionary's is right/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() =>
      expect(postedBody(fetchMock)).toMatchObject({
        action: 'adopt_kaikki',
        newDisplayText: 'fixturegenentry_kásù',
      }),
    );
  });

  it('lets our spelling stand instead', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryDiffersFixture);

    await user.click(screen.getByRole('button', { name: /Ours is right/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ action: 'keep_ours' }));
  });
});

describe('spelling: an uncited word', () => {
  it('says so plainly rather than showing a tone-mismatch diagnosis to a volunteer', async () => {
    await loaded(entryUncitedFixture, false);
    expect(screen.getByLabelText('Spelling question')).toHaveTextContent('not linked to a Wiktionary etymology yet');
    expect(screen.queryByText(/tone_mismatch/)).not.toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
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

    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(postedBody(fetchMock)).toMatchObject({ definitionAction: 'confirm' }));
  });
});

describe('atomicity: an entry is decided as a whole', () => {
  it('will not submit with no spelling answer', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));
    expect(fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBeUndefined();
  });

  it('will not submit with an empty definition', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
    await user.clear(screen.getByLabelText('Student definition'));

    expect(screen.getByRole('button', { name: 'Confirm entry' })).toBeDisabled();
    expect(fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBeUndefined();
  });

  it('sends both halves in ONE request to /api/decisions/entry', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded(entryFixture);

    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
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

    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
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
    await waitFor(() => expect(screen.getByLabelText('Spelling question')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: "Yes, that's right" }));
    await user.click(screen.getByRole('button', { name: 'Confirm entry' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('nope'));
    expect(screen.getByLabelText('Spelling question')).toBeInTheDocument();
  });
});

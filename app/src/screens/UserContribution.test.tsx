// @vitest-environment jsdom
//
// The screen that replaces a link which went to the wrong place: every row in a user's
// activity list used to open the review form, which asks the curator for their own opinion
// and shows nothing of the person's whose row it was.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { UserContribution } from './UserContribution.js';
import type { UserContributionDetail } from '../api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const BASE: UserContributionDetail = {
  userId: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  releaseState: 'agreed',
  contribution: {
    contributionId: 'c1',
    axis: 'entry',
    status: 'active',
    proposedValue: { action: 'respell', newDisplayText: 'ọwọ́' },
    resolvedValue: { kind: 'entry', displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'], definitionText: 'hand', citedEntryId: null },
    valueFingerprint: 'fp-1',
    note: 'the tone was wrong',
    submittedAt: '2026-08-01T10:00:00.000Z',
    excludedReason: null,
    excludedAt: null,
    agreesWithRecord: true,
  },
  alsoOnThisWord: [],
  word: {
    wordId: 'owo_hand',
    displayText: 'ọwọ́',
    syllables: ['ọ', 'wọ́'],
    definition: 'hand',
    entryType: null,
    pos: 'noun',
    englishGloss: 'hand',
    citedEntryId: null,
    components: [],
  },
  examples: [],
  recordings: [],
};

function mount(over: Partial<UserContributionDetail> = {}, handlers: Partial<Parameters<typeof UserContribution>[0]> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...BASE, ...over }) });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <UserContribution
      userId="u1"
      contributionId="c1"
      onOpenUser={vi.fn()}
      onOpenDossier={vi.fn()}
      onOpenWord={vi.fn()}
      {...handlers}
    />,
  );
  return fetchMock;
}

describe('one person\'s contribution', () => {
  it('asks for the contribution scoped to the person whose page it was reached from', async () => {
    const fetchMock = mount();
    await waitFor(() => expect(fetchMock.mock.calls[0][0]).toBe('/api/users/u1/contributions/c1'));
  });

  it('shows the claim they made, as the claim rather than as the action', async () => {
    mount();
    const claim = await waitFor(() => screen.getByLabelText('Claim: entry'));
    // The resolved outcome, not 'respell' - a curator is comparing assertions about a word,
    // and two routes to the same assertion should read identically.
    expect(claim).toHaveTextContent('ọwọ́');
    expect(claim).toHaveTextContent('hand');
    expect(claim).toHaveTextContent('the tone was wrong');
    expect(claim).toHaveTextContent('this is what the record says');
  });

  it('names the word and the person, so nothing the row promised is lost', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('ọwọ́'));
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/owo_hand/)).toBeInTheDocument();
  });

  it('offers no way to change the record', async () => {
    // The word dossier moderates; this screen is reached with one person's name at the top,
    // and a moderation control in that frame asks "is Ada right?" rather than "what is true?".
    mount({
      contribution: { ...BASE.contribution, status: 'active' },
      examples: [
        {
          exampleId: 'e1',
          exampleType: 'usage_phrase',
          exampleText: 'ọwọ́ mi',
          translation: 'my hand',
          audioDataBase64: 'QUJD',
          submittedAt: '2026-08-02T10:00:00.000Z',
          recordedWordText: 'ọwọ́',
          wordTextChanged: false,
          excludedReason: null,
          excludedAt: null,
        },
      ],
    });
    await waitFor(() => screen.getByLabelText('Claim: entry'));
    for (const label of [/remove/i, /exclude/i, /set the record/i, /confirm/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('shows what the record says now, beside the claim', async () => {
    mount({ contribution: { ...BASE.contribution, agreesWithRecord: false } });
    const now = await waitFor(() => screen.getByLabelText('The record now'));
    expect(now).toHaveTextContent('ọwọ́');
    expect(screen.getByLabelText('Claim: entry')).toHaveTextContent('the record says something else');
  });

  it('says agreement is unknown rather than denied when nothing has been decided', async () => {
    mount({ contribution: { ...BASE.contribution, agreesWithRecord: null } });
    const claim = await waitFor(() => screen.getByLabelText('Claim: entry'));
    expect(claim).toHaveTextContent('nothing decided on this axis yet');
    expect(claim).not.toHaveTextContent('the record says something else');
  });

  it('shows a superseded or excluded claim as such rather than hiding it', async () => {
    mount({
      contribution: {
        ...BASE.contribution,
        status: 'excluded',
        excludedReason: 'test data',
        excludedAt: '2026-08-05T10:00:00.000Z',
      },
    });
    const claim = await waitFor(() => screen.getByLabelText('Claim: entry'));
    expect(claim).toHaveTextContent('excluded');
    expect(claim).toHaveTextContent('test data');
  });

  it('plays their recordings, and warns when a take no longer matches the word', async () => {
    mount({
      recordings: [
        {
          utteranceId: 'utt1',
          speakerId: 's1',
          speakerName: 'Ada',
          takeNumber: 2,
          status: 'segmented',
          recordedDisplayText: 'ọwọ',
          recordedSyllables: ['ọ', 'wọ'],
          matchesGolden: false,
          durationS: 1.25,
          recordedAt: '2026-08-03T10:00:00.000Z',
          segmentCount: 2,
          releaseState: 'agreed',
          audioDataBase64: 'QUJD',
          deliveryMediaType: 'audio/wav',
        },
      ],
    });
    const audio = await waitFor(() => screen.getByLabelText('Their recordings'));
    expect(audio).toHaveTextContent('take 2');
    expect(audio).toHaveTextContent('no longer matches');
    // The bytes are inline, so there is something to press - the word dossier lists
    // recordings and offers no way to hear one.
    expect(audio.querySelector('audio')).toHaveAttribute('src');
  });

  it('says so rather than showing a dead player when no delivery copy is stored', async () => {
    mount({
      recordings: [
        {
          utteranceId: 'utt1',
          speakerId: 's1',
          speakerName: 'Ada',
          takeNumber: 1,
          status: 'pending_processing',
          recordedDisplayText: 'ọwọ́',
          recordedSyllables: ['ọ', 'wọ́'],
          matchesGolden: true,
          durationS: null,
          recordedAt: '2026-08-03T10:00:00.000Z',
          segmentCount: 0,
          releaseState: 'agreed',
          audioDataBase64: null,
          deliveryMediaType: null,
        },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Their recordings'));
    expect(section).toHaveTextContent('No playable copy');
    expect(section.querySelector('audio')).toBeNull();
  });

  it('warns that unpublishable work is unpublishable, beside the work', async () => {
    // 'unknown' means nobody has asked yet, which 0019 keeps distinct from a refusal. A
    // curator reading a recording must not be able to mistake either for a clearance.
    mount({
      releaseState: 'unknown',
      recordings: [
        {
          utteranceId: 'utt1',
          speakerId: 's1',
          speakerName: 'Ada',
          takeNumber: 1,
          status: 'segmented',
          recordedDisplayText: 'ọwọ́',
          recordedSyllables: ['ọ', 'wọ́'],
          matchesGolden: true,
          durationS: 1,
          recordedAt: '2026-08-03T10:00:00.000Z',
          segmentCount: 2,
          releaseState: 'revoked',
          audioDataBase64: 'QUJD',
          deliveryMediaType: 'audio/wav',
        },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Their recordings'));
    expect(section).toHaveTextContent('rights: revoked');
  });

  it('renders a new-word proposal, which has no word to hang on', async () => {
    // The case the word dossier structurally cannot show, and the row the user page used to
    // render as dead text.
    mount({
      word: null,
      contribution: {
        ...BASE.contribution,
        axis: 'new_entry',
        resolvedValue: null,
        proposedValue: { proposedWordId: 'ikun_stomach', displayText: 'ìkùn' },
      },
    });
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('A proposed new word'));
    expect(screen.getByLabelText('Claim: new_entry')).toHaveTextContent('ikun_stomach');
    // Nothing to link to, so no word buttons at all rather than ones that go nowhere.
    expect(screen.queryByRole('button', { name: 'Everything on this word' })).not.toBeInTheDocument();
  });

  it('links on to the word dossier, which is where moderating happens', async () => {
    const onOpenDossier = vi.fn();
    mount({}, { onOpenDossier });
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole('button', { name: 'Everything on this word' }));
    await user.click(screen.getByRole('button', { name: 'Everything on this word' }));
    expect(onOpenDossier).toHaveBeenCalledWith('owo_hand');
  });

  it("groups their other axes on the same word under their name", async () => {
    mount({
      alsoOnThisWord: [
        {
          contributionId: 'c2',
          axis: 'etymology',
          status: 'active',
          proposedValue: { componentsAction: 'confirm_atomic' },
          resolvedValue: { kind: 'etymology', components: [], atomic: true },
          valueFingerprint: 'fp-2',
          note: null,
          submittedAt: '2026-08-04T10:00:00.000Z',
          excludedReason: null,
          excludedAt: null,
          agreesWithRecord: null,
        },
      ],
    });
    const also = await waitFor(() => screen.getByLabelText('Their other claims'));
    expect(also).toHaveTextContent('Ada Lovelace');
    expect(within(also).getByLabelText('Claim: etymology')).toHaveTextContent('atomic');
  });

  it('reports a failure to load rather than rendering an empty record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "contribution 'c1' not found" }) }),
    );
    render(
      <UserContribution userId="u1" contributionId="c1" onOpenUser={vi.fn()} onOpenDossier={vi.fn()} onOpenWord={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not found'));
  });
});

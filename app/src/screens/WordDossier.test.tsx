// @vitest-environment jsdom
//
// The deep view. Most of what it protects is data three migrations preserved on purpose and
// no screen has ever been able to read back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { WordDossier } from './WordDossier.js';
import type { ConsensusGroup, WordDossier as Dossier } from '../api.js';
import { differingFields, fingerprintIdentity } from '@yoruba-student-dict-platform/shared';
import type { ConsensusTallyEntry, ContributionOutcome } from '@yoruba-student-dict-platform/shared';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const BASE: Dossier = {
  wordId: 'owo_hand',
  displayText: 'ọwọ́',
  syllables: ['ọ', 'wọ́'],
  definition: 'hand',
  entryType: null,
  pos: 'noun',
  englishGloss: 'hand',
  etymidLabel: null,
  updatedAt: '2026-08-01T10:00:00.000Z',
  updatedByEmail: 'curator@example.com',
  citation: 'cited',
  citedEntryId: 'en-owo-yo-noun',
  exemptReason: null,
  pin: { pos: 'noun', glosses: ['hand'], canonicalForm: 'ọwọ́' },
  pinnedAt: '2026-07-01T10:00:00.000Z',
  pinnedByEmail: 'curator@example.com',
  components: [],
  usedAsComponentOf: [],
  decisions: [],
  contributions: [],
  recordings: [],
  examples: [],
  images: [],
  assignees: [],
};

function mount(over: Partial<Dossier> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...BASE, ...over }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<WordDossier wordId="owo_hand" onOpenWord={vi.fn()} onOpenDossier={vi.fn()} />);
  return fetchMock;
}

describe('the word dossier', () => {
  it('shows the pinned upstream copy itself, not just a verdict about it', async () => {
    mount();
    const upstream = await waitFor(() => screen.getByLabelText('Wiktionary citation'));
    expect(upstream).toHaveTextContent('canonicalForm');
    expect(upstream).toHaveTextContent('ọwọ́');
  });

  it('shows superseded contributions, marked as set aside', async () => {
    mount({
      contributions: [
        { contributionId: 'c1', axis: 'entry', status: 'superseded', proposedValue: {}, resolvedValue: { kind: 'entry' }, valueFingerprint: 'fp', note: null, submittedByEmail: 'v@example.com', submittedAt: '2026-07-02T00:00:00.000Z', excludedReason: null, excludedAt: null },
        { contributionId: 'c2', axis: 'entry', status: 'active', proposedValue: {}, resolvedValue: { kind: 'entry' }, valueFingerprint: 'fp2', note: null, submittedByEmail: 'v@example.com', submittedAt: '2026-07-03T00:00:00.000Z', excludedReason: null, excludedAt: null },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Contributions'));
    expect(section).toHaveTextContent('superseded');
    expect(section).toHaveTextContent('active');
  });

  it("marks a decision archived by the 0011 axis merge as archived", async () => {
    mount({
      decisions: [
        { axis: 'spelling', decision: {}, note: null, decidedByEmail: 'c@example.com', decidedAt: '2026-01-01T00:00:00.000Z', valueFingerprint: null, archived: true },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Decisions'));
    expect(section).toHaveTextContent('archived by the 0011 axis merge');
  });

  it("shows a recording's own pronunciation and whether it still matches", async () => {
    mount({
      recordings: [
        { utteranceId: 'u1', speakerId: 's1', speakerName: 'Teacher A', releaseState: 'agreed', takeNumber: 1, recordedDisplayText: 'ọwọ', recordedSyllables: ['ọ', 'wọ'], matchesGolden: false, durationS: 1.2, status: 'segmented', recordedAt: '2026-07-05T00:00:00.000Z', segmentCount: 2, lowestSegmentConfidence: 0.31 },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Recordings'));
    expect(section).toHaveTextContent('no longer matches');
    expect(section).toHaveTextContent('said as “ọwọ”');
    // The segmenter reports this per clip and nothing has ever read it, which is why the
    // question it was meant to answer has no data behind it.
    expect(section).toHaveTextContent('lowest confidence 0.31');
  });

  it('flags an example recorded under a superseded spelling', async () => {
    mount({
      examples: [
        { exampleId: 'e1', exampleType: 'usage_phrase', exampleText: 'mo ní ọwọ́', translation: 'I have a hand', authorEmail: 'v@example.com', releaseState: 'unknown', submittedAt: '2026-07-06T00:00:00.000Z', recordedWordText: 'ọwọ', wordTextChanged: true, excludedReason: null },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Examples'));
    expect(section).toHaveTextContent('recorded as ọwọ');
    expect(section).toHaveTextContent('respelled since');
  });

  it('says plainly that a missing image blocks the game', async () => {
    mount({ images: [] });
    const section = await waitFor(() => screen.getByLabelText('Images'));
    expect(section).toHaveTextContent('hard gate');
  });

  it('renders stored images from the new image route', async () => {
    mount({
      images: [
        { imageId: 'img-1', artStyle: 'cartoon', variantNumber: 1, contentType: 'image/png', byteLength: 100, uploadedAt: '2026-07-07T00:00:00.000Z' },
      ],
    });
    const section = await waitFor(() => screen.getByLabelText('Images'));
    const img = section.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/images/img-1');
  });

  it('shows the publication overrides, which were previously write-only', async () => {
    mount({ pos: 'noun', englishGloss: 'hand' });
    const record = await waitFor(() => screen.getByLabelText('Record'));
    expect(record).toHaveTextContent('Part of speech');
    expect(record).toHaveTextContent('noun');
  });
});

// ---------------------------------------------------------------------------
// Setting the record
// ---------------------------------------------------------------------------
//
// The section had no coverage at all, which is how it came to ship rendering a claim as a
// vote count and a list of usernames and nothing else. `mount` above answers every request
// with the dossier body, so getConsensus resolved to undefined and this section rendered
// null - the tests passed because the thing under test was never on screen.

function claim(fingerprint: string, voters: string[], outcome: ContributionOutcome): ConsensusTallyEntry {
  return {
    fingerprint,
    outcome,
    count: voters.length,
    voters,
    voterLabels: voters,
    earliestSubmittedAt: '2026-08-01T00:00:00.000Z',
  };
}

function consensusGroup(over: Partial<ConsensusGroup> & { summary?: never } = {}, tally: ConsensusTallyEntry[] = []): ConsensusGroup {
  const winner = tally.length > 0 && (tally.length === 1 || tally[0].count > tally[1].count) ? tally[0] : null;
  return {
    wordId: 'owo_hand',
    displayText: 'ọwọ́',
    currentDefinition: 'hand',
    currentSyllables: ['ọ', 'wọ́'],
    currentCitedEntryId: 'en-owo-yo-noun',
    axis: 'entry',
    decidedAt: null,
    decidedByEmail: null,
    labels: { components: {}, etymologies: {} },
    summary: {
      tally,
      winner,
      totalVotes: tally.reduce((n, t) => n + t.count, 0),
      agreementCount: winner?.count ?? 0,
      isContested: tally.length > 1,
      isTied: false,
      meetsThreshold: (winner?.count ?? 0) >= 2,
      dissentsFromGolden: [],
      bucket: tally.length > 1 ? 'contested' : 'single',
      differingFields: differingFields(tally.map((t) => t.outcome)),
      wordingOnly: tally.length > 1 && new Set(tally.map((t) => fingerprintIdentity(t.outcome))).size === 1,
    },
    ...over,
  };
}

/** Routes by URL, unlike `mount`: the dossier and the tally are two endpoints, and a single
 * canned body meant the tally never arrived. */
function mountWithConsensus(groups: ConsensusGroup[], over: Partial<Dossier> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    if (url.startsWith('/api/consensus')) return { ok: true, json: async () => ({ groups }) };
    return { ok: true, json: async () => ({ ...BASE, ...over }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<WordDossier wordId="owo_hand" onOpenWord={vi.fn()} onOpenDossier={vi.fn()} />);
  return fetchMock;
}

const ENTRY = (over: Partial<Extract<ContributionOutcome, { kind: 'entry' }>> = {}): ContributionOutcome => ({
  kind: 'entry',
  displayText: 'ọwọ́',
  syllables: ['ọ', 'wọ́'],
  definitionText: 'hand',
  citedEntryId: 'en-owo-yo-noun',
  ...over,
});

describe('setting the record from the dossier', () => {
  it('shows what each claim actually says, not just who said it', async () => {
    mountWithConsensus([
      consensusGroup({}, [
        claim('fp-a', ['ada@example.com'], ENTRY({ displayText: 'ọwọ́', definitionText: 'hand' })),
        claim('fp-b', ['bo@example.com'], ENTRY({ displayText: 'ọwọ̀', definitionText: 'broom' })),
      ]),
    ]);

    const section = await waitFor(() => screen.getByLabelText('Set the record'));
    const claims = within(section).getByLabelText('Claims for entry');
    // The two spellings differ by one tone mark. That difference IS the decision, and it was
    // the thing the old rendering left out entirely.
    expect(claims).toHaveTextContent('ọwọ́');
    expect(claims).toHaveTextContent('ọwọ̀');
    expect(claims).toHaveTextContent('hand');
    expect(claims).toHaveTextContent('broom');
    // The names stay - attribution is still worth having; it just is not the whole row.
    expect(claims).toHaveTextContent('ada@example.com');
    expect(claims).toHaveTextContent('bo@example.com');
  });

  it('names the fields the claims disagree on', async () => {
    mountWithConsensus([
      consensusGroup({}, [
        claim('fp-a', ['ada@example.com'], ENTRY({ displayText: 'ọwọ́' })),
        claim('fp-b', ['bo@example.com'], ENTRY({ displayText: 'ọwọ̀' })),
      ]),
    ]);
    const section = await waitFor(() => screen.getByLabelText('Set the record'));
    expect(within(section).getByLabelText('What differs')).toHaveTextContent('the spelling');
  });

  it('shows the record as it stands, so a no-op is distinguishable from a change', async () => {
    mountWithConsensus([
      consensusGroup({ currentDefinition: 'the hand' }, [
        claim('fp-a', ['ada@example.com'], ENTRY({ definitionText: 'a hand' })),
      ]),
    ]);
    const section = await waitFor(() => screen.getByLabelText('Set the record'));
    expect(within(section).getByLabelText('What the record says now')).toHaveTextContent('the hand');
  });

  it('renders a cited etymology as words rather than as an opaque upstream id', async () => {
    mountWithConsensus([
      consensusGroup(
        {
          labels: {
            components: {},
            etymologies: {
              'en-ko-yo-verb-1': {
                entryId: 'en-ko-yo-verb-1',
                form: 'kọ́',
                pos: 'verb',
                etymologyNumber: '2',
                glosses: ['to hang, suspend'],
              },
            },
          },
        },
        [claim('fp-a', ['ada@example.com'], ENTRY({ citedEntryId: 'en-ko-yo-verb-1' }))],
      ),
    ]);
    const claims = within(await waitFor(() => screen.getByLabelText('Set the record'))).getByLabelText('Claims for entry');
    expect(claims).toHaveTextContent('to hang, suspend');
    expect(claims).toHaveTextContent('etymology 2');
  });

  it('spells an etymology claim\'s components instead of listing bare word_ids', async () => {
    mountWithConsensus([
      consensusGroup(
        { axis: 'etymology', labels: { components: { oju_eye: 'ojú', ile_house: 'ilé' }, etymologies: {} } },
        [
          claim('fp-a', ['ada@example.com'], { kind: 'etymology', components: ['oju_eye', 'ile_house'], atomic: false }),
        ],
      ),
    ]);
    const claims = within(await waitFor(() => screen.getByLabelText('Set the record'))).getByLabelText('Claims for etymology');
    // The tone marks are the point: a word_id is orthography-insensitive, so `oju_eye` cannot
    // tell a curator whether the claim is about `ojú` or `òjò`.
    expect(claims).toHaveTextContent('ojú');
    expect(claims).toHaveTextContent('ilé');
  });

  it('sends the fingerprint of the claim the curator actually clicked', async () => {
    const fetchMock = mountWithConsensus([
      consensusGroup({}, [
        claim('fp-a', ['ada@example.com'], ENTRY({ displayText: 'ọwọ́' })),
        claim('fp-b', ['bo@example.com'], ENTRY({ displayText: 'ọwọ̀' })),
      ]),
    ]);
    const section = await waitFor(() => screen.getByLabelText('Set the record'));
    const rows = within(section).getByLabelText('Claims for entry').querySelectorAll('li');
    await userEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Set the record to this' }));

    const confirm = fetchMock.mock.calls.find(([url]) => url === '/api/consensus/confirm');
    expect(confirm).toBeDefined();
    expect(JSON.parse(confirm![1]!.body as string)).toEqual({
      items: [{ wordId: 'owo_hand', axis: 'entry', expectedFingerprint: 'fp-b' }],
    });
  });

  it('says so when nobody has answered either axis', async () => {
    mountWithConsensus([]);
    const section = await waitFor(() => screen.getByLabelText('Set the record'));
    expect(section).toHaveTextContent('nothing to ratify');
  });
});

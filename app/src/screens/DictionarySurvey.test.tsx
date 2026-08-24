// @vitest-environment jsdom
//
// The curator's survey. What is protected here is the distinction the old browse screen
// could not make: a fact about the corpus versus a fact about the reader, and a decided
// record versus somebody's unratified opinion.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DictionarySurvey } from './DictionarySurvey.js';
import type { SurveyWord } from '../api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function word(wordId: string, over: Partial<SurveyWord> = {}): SurveyWord {
  return {
    wordId,
    displayText: `display_${wordId}`,
    syllables: ['a'],
    definition: 'a thing',
    entryType: null,
    pos: null,
    englishGloss: null,
    etymidLabel: null,
    entry: 'none',
    etymology: 'none',
    speakerCount: 0,
    divergedSpeakerCount: 0,
    fullyCoveredSpeakerCount: 0,
    imageCount: 0,
    exampleCount: 0,
    staleExampleCount: 0,
    componentCount: 0,
    usedAsComponentOfCount: 0,
    assigneeCount: 0,
    citation: 'uncited',
    exemptReason: null,
    citedEntryId: null,
    gameBlockers: [],
    wiktionaryBlockers: [],
    ...over,
  };
}

/** The real summariser, so a test can never assert a count the server would not produce. */
function overviewFor(words: SurveyWord[]) {
  const zero = () => ({ golden: 0, provisional: 0, none: 0 });
  const o = {
    totalWords: words.length,
    entry: zero(),
    etymology: zero(),
    citation: { cited: 0, exempt: 0, uncited: 0 },
    audioCoverage: { none: 0, one: 0, two: 0, threeOrMore: 0 },
    wordsWithStaleAudio: 0,
    wordsWithNoImage: 0,
    wordsWithExamples: 0,
    gameReady: 0,
    gameBlockers: { no_matching_recording: 0, only_stale_recordings: 0, no_speaker_covers_syllables: 0, no_image: 0 },
    wiktionaryReady: 0,
    wiktionaryBlockers: { no_citation_row: 0, no_part_of_speech: 0, no_english_gloss: 0 },
  };
  for (const w of words) {
    o.entry[w.entry] += 1;
    o.etymology[w.etymology] += 1;
    o.citation[w.citation] += 1;
    if (w.speakerCount === 0) o.audioCoverage.none += 1;
    else if (w.speakerCount === 1) o.audioCoverage.one += 1;
    else if (w.speakerCount === 2) o.audioCoverage.two += 1;
    else o.audioCoverage.threeOrMore += 1;
    if (w.divergedSpeakerCount > 0) o.wordsWithStaleAudio += 1;
    if (w.imageCount === 0) o.wordsWithNoImage += 1;
    if (w.exampleCount > 0) o.wordsWithExamples += 1;
    if (w.gameBlockers.length === 0) o.gameReady += 1;
    for (const b of w.gameBlockers) o.gameBlockers[b] += 1;
    if (w.wiktionaryBlockers.length === 0) o.wiktionaryReady += 1;
    for (const b of w.wiktionaryBlockers) o.wiktionaryBlockers[b] += 1;
  }
  return o;
}

function mount(words: SurveyWord[], tab: 'overview' | 'words' = 'overview') {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ words, overview: overviewFor(words) }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const onTabChange = vi.fn();
  const onOpenDossier = vi.fn();
  const onOpenWord = vi.fn();
  const view = render(
    <DictionarySurvey tab={tab} onTabChange={onTabChange} onOpenDossier={onOpenDossier} onOpenWord={onOpenWord} />,
  );
  return { fetchMock, onTabChange, onOpenDossier, onOpenWord, view };
}

describe('the survey asks about the corpus, not the reader', () => {
  it('shows a word recorded by other people as recorded', async () => {
    // The defect it replaces: browse used the per-user flags, so a word three volunteers
    // had recorded read "not yet recorded" to a curator who had not recorded it.
    mount([word('w1', { speakerCount: 3, fullyCoveredSpeakerCount: 3 })], 'words');
    await waitFor(() => expect(screen.getByLabelText('Word survey')).toBeInTheDocument());

    const row = screen.getByText('display_w1').closest('tr')!;
    expect(within(row).getByTitle('speakers whose recording still matches the word')).toHaveTextContent('3');
  });

  it('distinguishes a decided record from an unratified opinion', async () => {
    mount([word('w1', { entry: 'golden' }), word('w2', { entry: 'provisional' }), word('w3')], 'words');
    await waitFor(() => expect(screen.getByLabelText('Word survey')).toBeInTheDocument());

    expect(within(screen.getByText('display_w1').closest('tr')!).getByText(/entry · decided/)).toBeInTheDocument();
    expect(within(screen.getByText('display_w2').closest('tr')!).getByText(/entry · proposed/)).toBeInTheDocument();
    expect(within(screen.getByText('display_w3').closest('tr')!).getByText(/entry · untouched/)).toBeInTheDocument();
  });

  it('reports stale recordings separately from missing ones', async () => {
    mount([word('w1', { speakerCount: 1, fullyCoveredSpeakerCount: 1, divergedSpeakerCount: 2 })], 'words');
    await waitFor(() => expect(screen.getByLabelText('Word survey')).toBeInTheDocument());
    expect(screen.getByText('+2 stale')).toBeInTheDocument();
  });
});

describe('the overview is a way into the list', () => {
  it('opens the words behind a count when it is clicked', async () => {
    const user = userEvent.setup();
    const { onTabChange } = mount([
      word('w1', { citation: 'uncited' }),
      word('w2', { citation: 'cited' }),
      word('w3', { citation: 'cited' }),
    ]);
    await waitFor(() => expect(screen.getByLabelText('Dictionary overview')).toBeInTheDocument());

    // Uncited words have only ever been a bare number in the drift report.
    const uncited = screen.getByRole('button', { name: /^Uncited/ });
    expect(uncited).toHaveTextContent('1');
    await user.click(uncited);

    expect(onTabChange).toHaveBeenCalledWith('words');
  });

  it('does not offer a count of zero as a link', async () => {
    mount([word('w1', { citation: 'cited' })]);
    await waitFor(() => expect(screen.getByLabelText('Dictionary overview')).toBeInTheDocument());
    const uncited = screen.getByRole('button', { name: /^Uncited/ });
    expect(uncited).toHaveTextContent('0');
    expect(uncited).toBeDisabled();
  });

  it('counts readiness by the same rules the export scripts apply', async () => {
    mount([
      word('w1', { speakerCount: 1, fullyCoveredSpeakerCount: 1, imageCount: 1 }),
      word('w2', { gameBlockers: ['no_image'] }),
    ]);
    await waitFor(() => expect(screen.getByLabelText('Dictionary overview')).toBeInTheDocument());
    const gameCard = screen.getByRole('heading', { name: 'Ready for the game' }).closest('.stat-card') as HTMLElement;
    expect(within(gameCard).getByRole('button', { name: /^Nothing blocking/ })).toHaveTextContent('1');
    expect(within(gameCard).getByRole('button', { name: /^no image/ })).toHaveTextContent('1');
  });
});

describe('the two levels are offered separately', () => {
  it('opens the dossier from the word, and the review screen from its own button', async () => {
    // Reading a word and working on it are different acts, so they are different controls.
    const user = userEvent.setup();
    const { onOpenDossier, onOpenWord } = mount([word('w1')], 'words');
    await waitFor(() => expect(screen.getByLabelText('Word survey')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'display_w1' }));
    expect(onOpenDossier).toHaveBeenCalledWith('w1');

    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(onOpenWord).toHaveBeenCalledWith('w1');
  });

  it('filters to one named population and says how many of the whole it is', async () => {
    const user = userEvent.setup();
    mount([word('w1', { imageCount: 0 }), word('w2', { imageCount: 1 })], 'words');
    await waitFor(() => expect(screen.getByLabelText('Word survey')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Filter'), 'image:none');
    expect(screen.getByLabelText('Survey count')).toHaveTextContent('1 of 2 entries');
    expect(screen.queryByText('display_w2')).not.toBeInTheDocument();
  });
});

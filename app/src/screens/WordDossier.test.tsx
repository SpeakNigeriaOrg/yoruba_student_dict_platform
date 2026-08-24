// @vitest-environment jsdom
//
// The deep view. Most of what it protects is data three migrations preserved on purpose and
// no screen has ever been able to read back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WordDossier } from './WordDossier.js';
import type { WordDossier as Dossier } from '../api.js';

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
    const upstream = await waitFor(() => screen.getByLabelText('Upstream citation'));
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

// @vitest-environment jsdom
//
// The example axis. Two things are being protected:
//
//   The writing works without a Yoruba keyboard - six tap-to-insert letters and a tone grid
//   per word, so no diacritic is ever typed and what the field shows is what gets stored.
//
//   All three parts are required together. An example without audio is not an example.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ExampleContribution } from './ExampleContribution.js';
import entryFixture from '../fixtures/entryReview.json';

/** MediaRecorder and getUserMedia do not exist in jsdom. This is the same shape
 * AudioRecording.test.tsx installs - enough for start/stop to resolve with a blob. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  constructor() {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  // decodeToSamples needs a real AudioContext; the screen catches its failure and reports
  // it, so give it one that produces usable PCM instead.
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData() {
        return {
          sampleRate: 16000,
          numberOfChannels: 1,
          length: 1600,
          getChannelData: () => new Float32Array(1600),
        };
      }
      close() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
});

function mockFetch(examples: unknown[] = []) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/examples')) {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ exampleId: 'e1' }) });
      return Promise.resolve({ ok: true, json: async () => ({ examples }) });
    }
    if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function loaded(examples: unknown[] = []) {
  const fetchMock = mockFetch(examples);
  render(<ExampleContribution wordId="w" />);
  await waitFor(() => expect(screen.getByLabelText('Kind of example')).toBeInTheDocument());
  return fetchMock;
}

function posted(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
  if (!call) throw new Error('no POST was made');
  return JSON.parse((call[1] as RequestInit).body as string);
}

/** Fills in a complete example: kind, phrase, translation, recording. */
async function fillIn(user: ReturnType<typeof userEvent.setup>, phrase: string, translation: string) {
  await user.click(screen.getByRole('button', { name: /A phrase built from this one/ }));
  await user.type(screen.getByLabelText(/in Yoruba/), phrase);
  await user.type(screen.getByLabelText('What does it mean in English?'), translation);
  await user.click(screen.getByRole('button', { name: 'Record' }));
  await user.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(screen.getByLabelText('Your recording')).toBeInTheDocument());
}

describe('choosing the kind first', () => {
  it('offers the three kinds WITH a worked example each, because those are the instructions', async () => {
    await loaded();
    const group = screen.getByLabelText('Kind of example');
    expect(within(group).getByText(/A word built from this one/)).toBeInTheDocument();
    expect(within(group).getByText('ilé → kúulé')).toBeInTheDocument();
    expect(within(group).getByText(/abo adìyẹ \(hen\)/)).toBeInTheDocument();
    expect(within(group).getByText(/Ọ̀pọ̀lọ́ ń fò \(the frog hops\)/)).toBeInTheDocument();
  });

  it('does not ask for the phrase until a kind is picked', async () => {
    await loaded();
    expect(screen.queryByLabelText('Phrase composer')).not.toBeInTheDocument();
  });

  it('records the chosen kind, which cannot be recovered from the text later', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded();
    await fillIn(user, 'abo adiyẹ', 'hen');
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => expect(posted(fetchMock)).toMatchObject({ exampleType: 'derived_phrase' }));
  });
});

describe('writing it without a Yoruba keyboard', () => {
  it('offers all six letters a phone cannot produce, capitals included', async () => {
    // Ọ̀pọ̀lọ́ ń fò starts with a capital underdotted vowel, and no amount of long-pressing
    // O on a phone produces Ọ.
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /A phrase built from this one/ }));

    const palette = screen.getByLabelText('Yoruba letters');
    for (const letter of ['ẹ', 'ọ', 'ṣ', 'Ẹ', 'Ọ', 'Ṣ']) {
      expect(within(palette).getByRole('button', { name: letter })).toBeInTheDocument();
    }
  });

  it('inserts a letter at the caret, not at the end', async () => {
    // A phrase gets edited in the middle - noticing a missing underdot in the first word
    // after typing the third is normal, and appending would put it in the wrong word.
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /A phrase built from this one/ }));

    const field = screen.getByLabelText(/in Yoruba/) as HTMLInputElement;
    await user.type(field, 'abo adiye');
    field.setSelectionRange(3, 3); // just after "abo"
    await user.click(within(screen.getByLabelText('Yoruba letters')).getByRole('button', { name: 'ṣ' }));

    expect(field).toHaveValue('aboṣ adiye');
  });

  it('gives each word its own tone grid, labelled so they can be told apart', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /A phrase built from this one/ }));
    await user.type(screen.getByLabelText(/in Yoruba/), 'abo adiye');

    expect(screen.getByLabelText('Tone of syllable 1 of word 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Tone of syllable 3 of word 2')).toBeInTheDocument();
  });

  it('composes the marked phrase from plain letters, and submits exactly that', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded();
    await user.click(screen.getByRole('button', { name: /A short phrase using it/ }));
    await user.type(screen.getByLabelText(/in Yoruba/), 'n fo');

    // A bare `n` arrives on MID (the macron convention is not universal), so making it
    // high is one tap - and mid must not have added a macron nobody chose.
    expect(screen.getByLabelText('Syllable 1 of word 1 mid tone')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByLabelText('Syllable 1 of word 1 high tone'));
    await user.click(screen.getByLabelText('Syllable 1 of word 2 low tone'));

    expect(screen.getByLabelText(/in Yoruba/)).toHaveValue('ń fò');

    await user.type(screen.getByLabelText('What does it mean in English?'), 'it hops');
    await user.click(screen.getByRole('button', { name: 'Record' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByLabelText('Your recording')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => expect(posted(fetchMock)).toMatchObject({ exampleText: 'ń fò' }));
  });

  it('leaves a bare n alone when the tone is untouched - no macron nobody asked for', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded();
    await user.click(screen.getByRole('button', { name: /A short phrase using it/ }));
    await user.type(screen.getByLabelText(/in Yoruba/), 'n fo');
    await user.type(screen.getByLabelText('What does it mean in English?'), 'x');
    await user.click(screen.getByRole('button', { name: 'Record' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByLabelText('Your recording')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => expect(posted(fetchMock).exampleText).toBe('n fo'));
  });

  it('says so when part of the phrase cannot be split, rather than silently rewriting it', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /A short phrase using it/ }));
    // `شعِ` rather than `gan-an`: the splitter now treats a hyphen as a separator, so `gan-an`
    // is two tone-editable pieces and no longer unsupported. An Ajami spelling still is.
    await user.type(screen.getByLabelText(/in Yoruba/), 'شعِ');

    expect(screen.getByLabelText('Unsupported words')).toBeInTheDocument();
  });

  it('gives a hyphenated word a grid per part instead of refusing it', async () => {
    // The improvement that came with it: a hyphenated word in an example sentence used to get no
    // tone grid at all, because the whole word refused.
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /A short phrase using it/ }));
    await user.type(screen.getByLabelText(/in Yoruba/), 'gan-an');

    expect(screen.queryByLabelText('Unsupported words')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tone of syllable 1 of word 2')).toBeInTheDocument();
  });
});

describe('all three parts, or nothing', () => {
  it('blocks submit until the phrase, the translation AND the audio are present', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /A phrase built from this one/ }));
    expect(screen.getByRole('button', { name: 'Submit example' })).toBeDisabled();

    await user.type(screen.getByLabelText(/in Yoruba/), 'abo adiye');
    expect(screen.getByRole('button', { name: 'Submit example' })).toBeDisabled();

    await user.type(screen.getByLabelText('What does it mean in English?'), 'hen');
    // Still blocked: hearing the word used is the point of the axis.
    expect(screen.getByRole('button', { name: 'Submit example' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Record' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit example' })).toBeEnabled());
  });

  it('sends all three in one request', async () => {
    const user = userEvent.setup();
    const fetchMock = await loaded();
    await fillIn(user, 'abo adiyẹ', 'hen');
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => {
      const body = posted(fetchMock);
      expect(body.exampleText).toBe('abo adiyẹ');
      expect(body.translation).toBe('hen');
      expect(typeof body.audioBase64).toBe('string');
      expect((body.audioBase64 as string).length).toBeGreaterThan(0);
    });
  });
});

describe("other people's examples", () => {
  const OTHERS = [
    {
      exampleId: 'x1',
      exampleType: 'usage_phrase',
      exampleText: 'Adìyẹ ń jẹ',
      translation: 'the chicken is eating',
      audioDataBase64: 'AAAA',
      submittedAt: '2026-08-01T00:00:00.000Z',
      contributorLabel: 'ben@example.com',
      isOwn: false,
      recordedWordText: 'adìyẹ',
      wordTextChanged: false,
    },
  ];

  it('are hidden before you contribute, so they cannot anchor your own', async () => {
    await loaded(OTHERS);
    expect(screen.queryByLabelText('Other examples')).not.toBeInTheDocument();
    expect(screen.queryByText('Adìyẹ ń jẹ')).not.toBeInTheDocument();
  });

  it('appear once you have given yours', async () => {
    const user = userEvent.setup();
    await loaded(OTHERS);
    await fillIn(user, 'abo adiyẹ', 'hen');
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => expect(screen.getByLabelText('Other examples')).toBeInTheDocument());
    expect(screen.getByText('Adìyẹ ń jẹ')).toBeInTheDocument();
  });

  it('says so plainly when yours is the first', async () => {
    const user = userEvent.setup();
    await loaded([]);
    await fillIn(user, 'abo adiyẹ', 'hen');
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => expect(screen.getByText(/yours is the first/)).toBeInTheDocument());
  });
});

describe('failures', () => {
  it('reports a load failure rather than rendering an empty screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    );
    render(<ExampleContribution wordId="w" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this word"));
  });

  it('surfaces a submit failure and keeps what was written', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/examples') && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'nope' }) });
      }
      if (url.includes('/examples')) return Promise.resolve({ ok: true, json: async () => ({ examples: [] }) });
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ExampleContribution wordId="w" />);
    await waitFor(() => expect(screen.getByLabelText('Kind of example')).toBeInTheDocument());
    await fillIn(user, 'abo adiyẹ', 'hen');
    await user.click(screen.getByRole('button', { name: 'Submit example' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('nope'));
    expect(screen.getByLabelText(/in Yoruba/)).toHaveValue('abo adiyẹ');
  });
});

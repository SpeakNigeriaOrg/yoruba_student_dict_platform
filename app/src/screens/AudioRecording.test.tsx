// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AudioRecording } from './AudioRecording.js';
// The 2-syllable ['wò','hun'] word, which is what the two-tone-burst audio below
// is built to match. entryReview.json is now the 3-syllable adìyẹ case.
import entryFixture from '../fixtures/entryReviewCitedDiffers.json';

const SAMPLE_RATE = 16000;

function silence(durationSeconds: number): Float32Array {
  return new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
}

function tone(durationSeconds: number, amplitude = 0.8, frequencyHz = 220): Float32Array {
  const n = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
  }
  return out;
}

function concat(...chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// entryFixture has 2 syllables (["ka", "su"]) - matching two-tone-burst
// synthetic audio makes the "counts match" path exercisable with real
// segmentation logic, not a stubbed segment count.
const TWO_SYLLABLE_SAMPLES = concat(silence(0.2), tone(0.3), silence(0.3), tone(0.3), silence(0.2));
const ONE_SYLLABLE_SAMPLES = concat(silence(0.2), tone(0.3), silence(0.2));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(['fake-audio-bytes']) });
    this.onstop?.();
  }
}

function installAudioMocks(decodedSamples: Float32Array) {
  const fakeTrack = { stop: vi.fn() };
  const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
    configurable: true,
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData() {
        return { getChannelData: () => decodedSamples, sampleRate: SAMPLE_RATE };
      }
      async close() {}
    },
  );
  // jsdom doesn't implement the Blob-URL API at all (browser-only) - no
  // existing function to spy on, so this is a plain assignment, not a mock.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock-url';
}

async function recordBothTakes(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Record/ }));
  await user.click(screen.getByRole('button', { name: /Stop/ }));
  await user.click(screen.getByRole('button', { name: /Record/ }));
  await user.click(screen.getByRole('button', { name: /Stop/ }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
});

function installDefaultFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

describe('AudioRecording', () => {
  it('is not an agreement-only screen: the tones being recorded can be corrected', async () => {
    // The defect class this guards against is a review surface whose only action is
    // agreement - it does not merely annoy reviewers, it corrupts the evidence,
    // because every recorded vote says yes when yes is the only thing clickable.
    // The audio axis is inherently generative (the act is contributing a recording),
    // and the tone of every syllable is one tap away, so a speaker who disagrees with
    // the tones on record says what they actually say.
    installDefaultFetchMock();
    render(<AudioRecording wordId="wòhun" isCurator={false} />);

    await waitFor(() => expect(screen.getByLabelText('Tone of syllable 1')).toBeInTheDocument());
    for (const tone of ['high', 'mid', 'low']) {
      expect(screen.getByRole('button', { name: `Syllable 1 ${tone} tone` })).toBeEnabled();
    }
  });

  beforeEach(() => {
    installDefaultFetchMock();
  });

  it('shows the syllables as separate columns with their tone highlighted, not a comma-separated string', async () => {
    // The screen this replaces asked for a spelling and a comma-separated syllable list, which made
    // it the one place in the app where tone is a diacritic to squint at.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);

    await waitFor(() => expect(screen.getByLabelText('Tone of syllable 1')).toBeInTheDocument());

    // One column per syllable of `wòhun`, and each column's own tone is the pressed button.
    expect(screen.getByLabelText('Tone of syllable 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Tone of syllable 3')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Syllable 1 low tone' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Syllable 2 mid tone' })).toHaveAttribute('aria-pressed', 'true');

    // And no comma-separated field survives for a word that syllabifies.
    expect(screen.queryByLabelText('Syllables (comma-separated)')).not.toBeInTheDocument();
  });

  it('sends the grid\'s syllables, and a spelling that is exactly their join', async () => {
    // One source of truth. The old pair of text fields let a speaker submit a split that disagreed
    // with the spelling they had just typed - and recorded_syllables then froze that disagreement.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('Tone of syllable 1'));

    // Change one tone, so what is submitted is demonstrably the grid's state and not the fixture's.
    await user.click(screen.getByRole('button', { name: 'Syllable 1 high tone' }));
    await recordBothTakes(user);
    await waitFor(() => screen.getByText(/matching the expected count/));
    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.recordedSyllables).toEqual(['wó', 'hun']);
      expect(body.recordedDisplayText).toBe('wóhun');
      expect((body.recordedSyllables as string[]).join('')).toBe(body.recordedDisplayText);
    });
  });

  it('records recording 1, then recording 2, segments it, and reports a matching syllable count', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

    await recordBothTakes(user);

    await waitFor(() => {
      expect(screen.getByText(/Detected 2 syllables, matching the expected count\./)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeEnabled();
  });

  it('reports a mismatch and keeps submit disabled when the detected count differs', async () => {
    installAudioMocks(ONE_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

    await recordBothTakes(user);

    await waitFor(() => {
      expect(screen.getByText(/Detected 1 syllables, but the pronunciation above has 2/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeDisabled();
  });

  it('falls back to plain fields only for a word nothing can syllabify, which must stay recordable', async () => {
    // The fallback's population is now what it says: text with no syllable model AT ALL, an Ajami
    // spelling being the real case. It used to catch hyphenated forms and every phrase as well,
    // because syllabifySpans refuses each of those as a whole - see the two tests below, which are
    // the branch those actually belong on.
    installAudioMocks(ONE_SYLLABLE_SAMPLES);
    const user = userEvent.setup();
    const ajami = { ...entryFixture, displayText: 'شعِ', syllables: ['شعِ'] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => ajami });
        if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<AudioRecording wordId="ajami" isCurator={false} />);
    await waitFor(() => expect(screen.getByLabelText('Cannot show a tone grid')).toBeInTheDocument());

    expect(screen.getByLabelText('Spelling')).toHaveValue('شعِ');
    expect(screen.getByLabelText('Syllables (comma-separated)')).toHaveValue('شعِ');
    expect(screen.queryByLabelText('Tone of syllable 1')).not.toBeInTheDocument();

    // And the count check still works off that field, so the word remains recordable.
    const syllablesField = screen.getByLabelText('Syllables (comma-separated)');
    await user.clear(syllablesField);
    await user.type(syllablesField, 'شع');
    await recordBothTakes(user);

    await waitFor(() => {
      expect(screen.getByText(/Detected 1 syllables, matching the expected count\./)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeEnabled();
  });

  it('gives a phrase one tone grid per word, which is the whole population that had none', async () => {
    // The bug this covers: syllabifySpans refuses every space, so EVERY phrase in the dictionary
    // took the unsplittable fallback and was told its tones "can't be shown as a grid". A phrase is
    // where the tone grid matters most - a phrase inherits its parts' spellings, and `o ṣé` is
    // exactly the case where one of them is wrong at mid tone.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();
    const phrase = { ...entryFixture, displayText: 'o ṣé', syllables: ['o', 'ṣé'] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => phrase });
        if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<AudioRecording wordId="o_se_thank_you" isCurator={false} />);
    // One grid per word, so the syllable numbering restarts and the word is named in the label.
    await waitFor(() => expect(screen.getByLabelText('Tone of syllable 1 of word 1')).toBeInTheDocument());
    expect(screen.getByLabelText('Tone of syllable 1 of word 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cannot show a tone grid')).not.toBeInTheDocument();

    // The count comes from the syllables, which do NOT include the space - two, not three.
    await recordBothTakes(user);
    await waitFor(() => {
      expect(screen.getByText(/Detected 2 syllables, matching the expected count\./)).toBeInTheDocument();
    });
  });

  it('gives a hyphenated word grids too, because a hyphen is a separator like a space', async () => {
    // `ilé-ìwé` and `aárùn-ún` are the real forms, and the hyphenated spelling is the LEMMA for an
    // elongated nasal - the one that says which way the nasal attaches. Refusing to grid it sent
    // the form we most want recorded to the retype-a-list fallback.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const hyphenated = { ...entryFixture, displayText: 'gan-an', syllables: ['gan', 'an'] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => hyphenated });
        if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<AudioRecording wordId="ganan" isCurator={false} />);
    await waitFor(() => expect(screen.getByLabelText('Tone of syllable 1 of word 1')).toBeInTheDocument());
    expect(screen.getByLabelText('Tone of syllable 1 of word 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cannot show a tone grid')).not.toBeInTheDocument();
    // The hyphen survives into what gets recorded - it is orthography, not a syllable boundary
    // we invented, and the spelling submitted has to be the one on screen.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('gan-an');
  });

  it('names the syllable and its tone against each detected clip, not the timings', async () => {
    // Start/end seconds and VAD confidence are our diagnostics. The question the speaker is
    // answering is "is this the right syllable, said the right way", which neither number helps with.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();
    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByLabelText('Tone of syllable 1'));
    await recordBothTakes(user);

    const segments = await waitFor(() => screen.getByLabelText('Detected segments'));
    expect(segments).toHaveTextContent('wò');
    expect(segments).toHaveTextContent('low');
    expect(segments).toHaveTextContent('hun');
    expect(segments).not.toHaveTextContent('confidence');
  });

  it('submits both takes (and every segment clip) inline as base64 audio, with the recorded pronunciation, to the register endpoint', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      if (url.includes('/utterances') && url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'fake-utterance-id' }) });
      }
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

    await recordBothTakes(user);
    await waitFor(() => screen.getByRole('button', { name: 'Submit recording' }));

    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Recording submitted.');
    });

    // No separate blob upload step - just two /register calls, each
    // carrying its own take's bytes inline.
    expect(fetchMock.mock.calls.some((c) => c[0].includes('blob.core.windows.net'))).toBe(false);

    const registerCalls = fetchMock.mock.calls.filter((c) => c[0].includes('/register'));
    expect(registerCalls).toHaveLength(2);
    const registeredBodies = registerCalls.map((c) => JSON.parse(c[1].body));
    for (const body of registeredBodies) {
      expect(typeof body.audioDataBase64).toBe('string');
      expect(body.audioDataBase64.length).toBeGreaterThan(0);
      expect(body.recordedDisplayText).toBe('wòhun');
      expect(body.recordedSyllables).toEqual(['wò', 'hun']);
    }
    const take2Register = registeredBodies.find((b) => b.takeNumber === 2);
    expect(take2Register.segments).toHaveLength(2);
    expect(take2Register.segments[0]).toMatchObject({ syllablePosition: 0 });
    expect(typeof take2Register.segments[0].audioDataBase64).toBe('string');
  });

  it("records the word's OWN stored split rather than re-deriving one", async () => {
    // The defect: this screen always re-derived the split with syllabifySpans and threw away
    // golden_record's. But applyEntryDecision's `respell` writes an AUTHORED split - "freeing a
    // nasal is a respell whose whole content is the new split" - and re-deriving undid exactly
    // that correction. Worse, the re-derived split is then what the publish comparison rejects,
    // so a speaker who changed nothing produced a recording that could never be published.
    //
    // ['wòh','un'] is not a split syllabifySpans would ever produce, which is the point: it can
    // only be here because a human authored it.
    const authored = { ...entryFixture, displayText: 'wòhun', syllables: ['wòh', 'un'] };
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => authored });
      if (url.includes('/utterances') && url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'id', matchesGolden: true }) });
      }
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));
    await recordBothTakes(user);
    await waitFor(() => screen.getByRole('button', { name: 'Submit recording' }));
    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0].includes('/register'))).toHaveLength(2));
    const body = JSON.parse(fetchMock.mock.calls.filter((c) => c[0].includes('/register'))[0][1].body);
    expect(body.recordedSyllables).toEqual(['wòh', 'un']);
    expect(body.recordedDisplayText).toBe('wòhun');
  });

  it('says a recording will not publish, while still counting the task as done', async () => {
    // The beta-test bug. The screen used to report a bare "Recording submitted." whatever the
    // outcome, and the axis then stayed red, so the queue handed back the identical task with no
    // explanation. Both halves are asserted here: the message says what happened, and onDecided
    // still fires so the queue moves on.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      if (url.includes('/utterances') && url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'id', matchesGolden: false }) });
      }
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDecided = vi.fn();
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} onDecided={onDecided} />);
    await waitFor(() => screen.getByText('wòhun'));
    await recordBothTakes(user);
    await waitFor(() => screen.getByRole('button', { name: 'Submit recording' }));
    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    const banner = await waitFor(() => screen.getByLabelText('Recording saved but not publishable'));
    expect(banner).toHaveTextContent('your audio task is done');
    expect(banner).toHaveTextContent('will not be published');
    expect(onDecided).toHaveBeenCalled();
  });

  it('treats a response with no matchesGolden as "not known", not as a problem', async () => {
    // The field is optional on the client so an older deployment reads as unknown. Announcing a
    // divergence nobody reported would be worse than saying nothing.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
      if (url.includes('/utterances') && url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'id' }) });
      }
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));
    await recordBothTakes(user);
    await waitFor(() => screen.getByRole('button', { name: 'Submit recording' }));
    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Recording submitted.'));
    expect(screen.queryByLabelText('Recording saved but not publishable')).not.toBeInTheDocument();
  });

  it('warns BEFORE recording when the pronunciation already differs from the record', async () => {
    // A word whose stored split cannot reconstitute its spelling falls back to a derived one, so
    // what is about to be recorded diverges from the outset. The speaker should be choosing that,
    // not discovering it from a banner after they have finished.
    const inconsistent = { ...entryFixture, displayText: 'wòhun', syllables: ['wò', 'hun', 'extra'] };
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => inconsistent });
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);

    const notice = await waitFor(() => screen.getByLabelText('Pronunciation differs from the record'));
    expect(notice).toHaveTextContent('your task counts');

    // Not a block. The tester's point was that a conflict is worth communicating and not worth
    // refusing, so submitting stays reachable with the notice on screen.
    await recordBothTakes(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit recording' })).toBeEnabled());
    expect(screen.getByLabelText('Pronunciation differs from the record')).toBeInTheDocument();
  });

  it('asks the speaker to say the spelling THEY corrected it to, not the one on record', async () => {
    // The whole point of correcting a spelling is that you think that is how the word is
    // said. Seeding from the record offered the old pronunciation to someone who had just
    // argued against it - and produced a recording publish would drop. Their own answer is
    // a contribution, which never reaches golden_record, so nothing here could see it until
    // getEntryReview started reporting it.
    const proposed = {
      ...entryFixture,
      displayText: 'wòhun',
      syllables: ['wò', 'hun'],
      myProposedEntry: { displayText: 'wóhun', syllables: ['wó', 'hun'] },
    };
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => proposed });
      if (url.includes('/utterances') && url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'id', matchesGolden: false }) });
      }
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wóhun'));

    // And it says whose spelling it is, rather than reporting a bare mismatch.
    const notice = screen.getByLabelText('Pronunciation differs from the record');
    expect(notice).toHaveTextContent('your');
    expect(notice).toHaveTextContent('wòhun');

    await recordBothTakes(user);
    await waitFor(() => screen.getByRole('button', { name: 'Submit recording' }));
    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0].includes('/register'))).toHaveLength(2));
    const body = JSON.parse(fetchMock.mock.calls.filter((c) => c[0].includes('/register'))[0][1].body);
    expect(body.recordedDisplayText).toBe('wóhun');
    expect(body.recordedSyllables).toEqual(['wó', 'hun']);
  });

  it('falls back to the record when the speaker has proposed nothing', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => ({ ...entryFixture, myProposedEntry: null }) });
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));
    expect(screen.queryByLabelText('Pronunciation differs from the record')).not.toBeInTheDocument();
  });

  it('shows a VOLUNTEER no other speakers at all - not even an empty section', async () => {
    // Hearing someone else say the word first is an anchor, and the point of every participant
    // recording every word themselves is INDEPENDENT pronunciations - the divergence between
    // speakers is the signal being collected, so a reference take converts it into imitation.
    // The API does not send a volunteer these rows either (listUtterances.ts); this asserts the
    // screen does not ask for a section to put them in.
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

    expect(await screen.findByLabelText('Your recordings')).toBeInTheDocument();
    // Absent, not empty: "No other speakers have recorded this word yet" is itself information
    // about other people, and it would be a claim this screen can no longer support.
    expect(screen.queryByLabelText("Other speakers' recordings")).not.toBeInTheDocument();
    expect(screen.queryByText(/No other speakers have recorded/)).not.toBeInTheDocument();
  });

  it("shows a CURATOR another speaker's recording, clearly separated from - and never counted as - their own", async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const otherSpeakerUtterance = {
      utteranceId: 'utt-1',
      speakerId: 'spk-1',
      speakerDisplayName: 'speaker3',
      isOwnRecording: false,
      takeNumber: 1,
      status: 'pending_processing',
      recordedDisplayText: 'wòhun',
      recordedSyllables: ['wò', 'hun'],
      durationS: 1.1,
      sampleRate: 16000,
      recordedAt: '2026-01-01T00:00:00.000Z',
      audioDataBase64: Buffer.from('take1-bytes').toString('base64'),
      rawAudioDataBase64: Buffer.from('take1-bytes').toString('base64'),
      segments: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
        if (url.includes('/utterances'))
          return Promise.resolve({ ok: true, json: async () => ({ utterances: [otherSpeakerUtterance] }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByText('wòhun'));

    const yours = await screen.findByLabelText('Your recordings');
    expect(yours).toHaveTextContent("You haven't recorded this word yet.");
    // Raw internal status text should never be shown to the person recording.
    expect(yours).not.toHaveTextContent('pending_processing');

    const others = screen.getByLabelText("Other speakers' recordings");
    expect(others).toHaveTextContent('speaker3');
    expect(others).toHaveTextContent('take 1');
    expect(others).not.toHaveTextContent('pending_processing');
  });

  it("shows the current user's own recording under 'Your recordings', without a speaker name", async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const ownUtterance = {
      utteranceId: 'utt-2',
      speakerId: 'spk-2',
      speakerDisplayName: 'the-current-users-display-name',
      isOwnRecording: true,
      takeNumber: 1,
      status: 'pending_processing',
      recordedDisplayText: 'wòhun',
      recordedSyllables: ['wò', 'hun'],
      durationS: 1.1,
      sampleRate: 16000,
      recordedAt: '2026-01-01T00:00:00.000Z',
      audioDataBase64: Buffer.from('take1-bytes').toString('base64'),
      rawAudioDataBase64: Buffer.from('take1-bytes').toString('base64'),
      segments: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/entry')) return Promise.resolve({ ok: true, json: async () => entryFixture });
        if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [ownUtterance] }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={true} />);
    await waitFor(() => screen.getByText('wòhun'));

    const yours = await screen.findByLabelText('Your recordings');
    expect(yours).toHaveTextContent('take 1');
    expect(yours).not.toHaveTextContent('the-current-users-display-name');

    const others = screen.getByLabelText("Other speakers' recordings");
    expect(others).toHaveTextContent('No other speakers have recorded this word yet.');
  });

  it('lets take 1 be re-recorded - clicking Re-record shows the Stop button, not a stuck Re-record button', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

    await user.click(screen.getByRole('button', { name: /Record/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(screen.getByRole('button', { name: 'Re-record' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Re-record' }));

    // The bug: take1Blob never cleared, so this stayed on the
    // already-recorded branch (audio player + Re-record button) forever,
    // even though a new recording had silently started underneath.
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-record' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(screen.getByRole('button', { name: 'Re-record' })).toBeInTheDocument();
  });

  it('shows a microphone error message when getUserMedia rejects', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('permission denied')) },
      configurable: true,
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

    await user.click(screen.getByRole('button', { name: /Record/ }));

    await waitFor(() => {
      expect(screen.getByText(/Microphone error: permission denied/)).toBeInTheDocument();
    });
  });
});

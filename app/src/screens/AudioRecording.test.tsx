// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AudioRecording } from './AudioRecording.js';
import spellingFixture from '../fixtures/spellingReview.json';

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

// spellingFixture has 2 syllables (["ka", "su"]) - matching two-tone-burst
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
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

describe('AudioRecording', () => {
  beforeEach(() => {
    installDefaultFetchMock();
  });

  it('defaults the pronunciation fields from the word being reviewed', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);

    await waitFor(() => {
      expect(screen.getByText('fixturegenspldef_kasu')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Spelling')).toHaveValue('fixturegenspldef_kasu');
    expect(screen.getByLabelText('Syllables (comma-separated)')).toHaveValue('ka,su');
  });

  it('records recording 1, then recording 2, segments it, and reports a matching syllable count', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await recordBothTakes(user);

    await waitFor(() => {
      expect(screen.getByText(/Detected 2 syllables, matching the expected count\./)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeEnabled();
  });

  it('reports a mismatch and keeps submit disabled when the detected count differs', async () => {
    installAudioMocks(ONE_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await recordBothTakes(user);

    await waitFor(() => {
      expect(screen.getByText(/Detected 1 syllables, but the pronunciation above has 2/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeDisabled();
  });

  it('re-checks the count against an edited syllables field, not the word\'s original syllabification', async () => {
    // A speaker recording a pronunciation that legitimately differs from
    // golden_record's current syllable split (e.g. before a later
    // spelling decision converges on something else) edits the syllables
    // field down to 1 - the 1-syllable synthetic audio should now match.
    installAudioMocks(ONE_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    const syllablesField = screen.getByLabelText('Syllables (comma-separated)');
    await user.clear(syllablesField);
    await user.type(syllablesField, 'kasu');

    await recordBothTakes(user);

    await waitFor(() => {
      expect(screen.getByText(/Detected 1 syllables, matching the expected count\./)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeEnabled();
  });

  it('submits both takes (and every segment clip) inline as base64 audio, with the recorded pronunciation, to the register endpoint', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      if (url.includes('/utterances') && url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'fake-utterance-id' }) });
      }
      if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

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
      expect(body.recordedDisplayText).toBe('fixturegenspldef_kasu');
      expect(body.recordedSyllables).toEqual(['ka', 'su']);
    }
    const take2Register = registeredBodies.find((b) => b.takeNumber === 2);
    expect(take2Register.segments).toHaveLength(2);
    expect(take2Register.segments[0]).toMatchObject({ syllablePosition: 0 });
    expect(typeof take2Register.segments[0].audioDataBase64).toBe('string');
  });

  it("lists previous recordings from any speaker, so a curator can listen without needing that speaker's own login", async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const previousUtterance = {
      utteranceId: 'utt-1',
      speakerId: 'spk-1',
      speakerDisplayName: 'speaker3',
      takeNumber: 1,
      status: 'pending_processing',
      recordedDisplayText: 'fixturegenspldef_kasu',
      recordedSyllables: ['ka', 'su'],
      durationS: 1.1,
      sampleRate: 16000,
      recordedAt: '2026-01-01T00:00:00.000Z',
      audioDataBase64: Buffer.from('take1-bytes').toString('base64'),
      segments: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
        if (url.includes('/utterances')) return Promise.resolve({ ok: true, json: async () => ({ utterances: [previousUtterance] }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    const list = await screen.findByLabelText('Recordings by speaker');
    expect(list).toHaveTextContent('speaker3');
    expect(list).toHaveTextContent('take 1');
    expect(list).toHaveTextContent('pending_processing');
  });

  it('shows a microphone error message when getUserMedia rejects', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('permission denied')) },
      configurable: true,
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await user.click(screen.getByRole('button', { name: /Record/ }));

    await waitFor(() => {
      expect(screen.getByText(/Microphone error: permission denied/)).toBeInTheDocument();
    });
  });
});

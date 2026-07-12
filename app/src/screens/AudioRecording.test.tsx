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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
});

describe('AudioRecording', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => spellingFixture }));
  });

  it('shows the expected syllable count once the word loads', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);

    await waitFor(() => {
      expect(screen.getByText('fixturegenspldef_kasu')).toBeInTheDocument();
    });
    expect(screen.getByText('Expected syllables: 2')).toBeInTheDocument();
  });

  it('records take 1, then take 2, segments it, and reports a matching syllable count', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await user.click(screen.getByRole('button', { name: /Record take 1/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));

    await user.click(screen.getByRole('button', { name: /Record take 2/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));

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

    await user.click(screen.getByRole('button', { name: /Record take 1/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    await user.click(screen.getByRole('button', { name: /Record take 2/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));

    await waitFor(() => {
      expect(screen.getByText(/Detected 1 syllables, but this word has 2/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Submit recording' })).toBeDisabled();
  });

  it('submits both takes and every segment clip through the SAS-token upload + register flow', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/spelling')) return Promise.resolve({ ok: true, json: async () => spellingFixture });
      if (url.includes('/sas-token')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            containerUrl: 'https://fakeaccount.blob.core.windows.net/utterances',
            sasQuery: 'sv=fake&sp=cw',
            blobPrefix: 'utterances/fixturegenspldef_spellingword/fake-uuid/',
            expiresAt: new Date(Date.now() + 900000).toISOString(),
          }),
        });
      }
      if (url.includes('blob.core.windows.net')) {
        expect(init?.method).toBe('PUT');
        return Promise.resolve({ ok: true, status: 201 });
      }
      if (url.includes('/register')) {
        return Promise.resolve({ ok: true, json: async () => ({ utteranceId: 'fake-utterance-id' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" />);
    await waitFor(() => screen.getByText('fixturegenspldef_kasu'));

    await user.click(screen.getByRole('button', { name: /Record take 1/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    await user.click(screen.getByRole('button', { name: /Record take 2/ }));
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => screen.getByRole('button', { name: 'Submit recording' }));

    await user.click(screen.getByRole('button', { name: 'Submit recording' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Recording submitted.');
    });

    const sasCall = fetchMock.mock.calls.find((c) => c[0].includes('/sas-token'));
    expect(sasCall).toBeDefined();
    expect(JSON.parse(sasCall![1].body)).toEqual({ wordId: 'fixturegenspldef_spellingword' });

    const uploadCalls = fetchMock.mock.calls.filter((c) => c[0].includes('blob.core.windows.net'));
    // take1 + take2 + 2 segment clips (matching the 2-syllable fixture).
    expect(uploadCalls).toHaveLength(4);

    const registerCalls = fetchMock.mock.calls.filter((c) => c[0].includes('/register'));
    expect(registerCalls).toHaveLength(2);
    const take2Register = registerCalls.map((c) => JSON.parse(c[1].body)).find((b) => b.takeNumber === 2);
    expect(take2Register.segments).toHaveLength(2);
    expect(take2Register.segments[0]).toMatchObject({ syllablePosition: 0 });
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

    await user.click(screen.getByRole('button', { name: /Record take 1/ }));

    await waitFor(() => {
      expect(screen.getByText(/Microphone error: permission denied/)).toBeInTheDocument();
    });
  });
});

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
  it('is not an agreement-only screen: the pronunciation being recorded can be corrected', async () => {
    // The defect class this guards against is a review surface whose only action is
    // agreement - it does not merely annoy reviewers, it corrupts the evidence,
    // because every recorded vote says yes when yes is the only thing clickable.
    // The audio axis is inherently generative (the act is contributing a recording),
    // and both fields describing what is being said are editable, so a speaker who
    // disagrees with the spelling or the split records what they actually say.
    installDefaultFetchMock();
    render(<AudioRecording wordId="wòhun" isCurator={false} />);

    await waitFor(() => expect(screen.getByLabelText('Spelling')).toBeInTheDocument());
    expect(screen.getByLabelText('Spelling')).not.toBeDisabled();
    expect(screen.getByLabelText('Syllables (comma-separated)')).not.toBeDisabled();
  });

  beforeEach(() => {
    installDefaultFetchMock();
  });

  it('defaults the pronunciation fields from the word being reviewed', async () => {
    installAudioMocks(TWO_SYLLABLE_SAMPLES);
    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);

    await waitFor(() => {
      expect(screen.getByText('wòhun')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Spelling')).toHaveValue('wòhun');
    expect(screen.getByLabelText('Syllables (comma-separated)')).toHaveValue('wò,hun');
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

  it('re-checks the count against an edited syllables field, not the word\'s original syllabification', async () => {
    // A speaker recording a pronunciation that legitimately differs from
    // golden_record's current syllable split (e.g. before a later
    // spelling decision converges on something else) edits the syllables
    // field down to 1 - the 1-syllable synthetic audio should now match.
    installAudioMocks(ONE_SYLLABLE_SAMPLES);
    const user = userEvent.setup();

    render(<AudioRecording wordId="fixturegenspldef_spellingword" isCurator={false} />);
    await waitFor(() => screen.getByText('wòhun'));

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

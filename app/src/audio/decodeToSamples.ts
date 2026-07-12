// decodeToSamples.ts
//
// The one browser-dependent step in this module (AudioContext.decodeAudioData
// needs a real browser, can't be unit-tested in Node) - kept as a single
// thin wrapper so everything downstream (segmentSyllables.ts, encodeWav.ts)
// stays pure Float32Array/number math and fully testable without a browser.

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export async function decodeToSamples(blob: Blob): Promise<DecodedAudio> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    // Mono only - this project's recordings are a single speaker reading
    // one word into a single mic input, no downmixing needed.
    return { samples: audioBuffer.getChannelData(0), sampleRate: audioBuffer.sampleRate };
  } finally {
    await audioContext.close();
  }
}

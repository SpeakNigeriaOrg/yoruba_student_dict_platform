// encodeWav.ts
//
// Encodes Float32 PCM samples (the same shape segmentSyllables.ts already
// works with) as a 16-bit mono WAV Blob. Needed because
// syllable_observations.blob_path is a required (not null) per-syllable
// audio clip in the schema - each detected segment gets sliced out of the
// take-2 recording and uploaded as its own file, not just stored as a
// time-range into the parent recording. Pure byte-buffer math, no browser
// API - fully unit-testable in Node, same principle as keeping
// segmentSyllables.ts itself browser-independent.

const BYTES_PER_SAMPLE = 2; // 16-bit PCM

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function floatTo16BitPCM(view: DataView, offset: number, samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1] before scaling - a sample slightly outside that
    // range (clipping, floating-point overshoot) would otherwise wrap
    // around as a 16-bit integer instead of just clipping cleanly.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset + i * BYTES_PER_SAMPLE, value, true);
  }
}

export function encodeWavFromPCM(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  floatTo16BitPCM(view, 44, samples);

  return new Blob([buffer], { type: 'audio/wav' });
}

/** Slices [startSeconds, endSeconds) out of a full PCM buffer and encodes
 * just that range as its own WAV - the per-syllable clip a detected
 * segment's own start/end times describe. */
export function sliceAndEncodeWav(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
): Blob {
  const startIndex = Math.max(0, Math.round(startSeconds * sampleRate));
  const endIndex = Math.min(samples.length, Math.round(endSeconds * sampleRate));
  const slice = samples.subarray(startIndex, Math.max(startIndex, endIndex));
  return encodeWavFromPCM(slice, sampleRate);
}

// decodeAndSegment.ts
//
// Decodes the "syllables spoken with deliberate pauses" take (take 2 of
// the two-take protocol - see REMOTE_ACCESS_DISCUSSION.md's "Audio
// pipeline" section) and segments it. Thin composition of decodeToSamples
// (the browser-dependent half) and segmentSyllables (pure, unit-tested).

import { decodeToSamples } from './decodeToSamples.js';
import { segmentSyllables, type SegmentSyllablesOptions, type SyllableSegment } from './segmentSyllables.js';

export async function decodeAndSegment(
  blob: Blob,
  options?: SegmentSyllablesOptions,
): Promise<SyllableSegment[]> {
  const { samples, sampleRate } = await decodeToSamples(blob);
  return segmentSyllables(samples, sampleRate, options);
}

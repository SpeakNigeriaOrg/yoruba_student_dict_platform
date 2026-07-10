import { describe, expect, it } from 'vitest';
import { segmentSyllables } from './segmentSyllables';

const SAMPLE_RATE = 16000;

function silence(durationSeconds: number, noiseAmplitude = 0): Float32Array {
  const n = Math.round(durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  if (noiseAmplitude > 0) {
    for (let i = 0; i < n; i++) {
      out[i] = (Math.random() * 2 - 1) * noiseAmplitude;
    }
  }
  return out;
}

/** A synthetic "syllable" - a sine tone burst, standing in for real speech.
 * The segmenter only looks at energy, not frequency content, so a tone is
 * a faithful enough stand-in for testing boundary detection. */
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

describe('segmentSyllables', () => {
  it('finds zero segments in pure silence', () => {
    const samples = silence(1.0);
    expect(segmentSyllables(samples, SAMPLE_RATE)).toEqual([]);
  });

  it('finds zero segments in low-level background noise alone (no false positives)', () => {
    // Noise well below where a real syllable would sit - the recording's
    // own noise floor, not speech.
    const samples = silence(1.0, 0.02);
    expect(segmentSyllables(samples, SAMPLE_RATE)).toEqual([]);
  });

  it('finds one segment for a single tone burst', () => {
    const samples = concat(silence(0.3), tone(0.3), silence(0.3));
    const segments = segmentSyllables(samples, SAMPLE_RATE);
    expect(segments).toHaveLength(1);
    expect(segments[0].syllablePosition).toBe(0);
    expect(segments[0].startTimeSeconds).toBeCloseTo(0.3, 1);
    expect(segments[0].endTimeSeconds).toBeCloseTo(0.6, 1);
  });

  it('finds three segments, in order, for three tone bursts with clear pauses (the actual protocol)', () => {
    const samples = concat(
      silence(0.2),
      tone(0.25),
      silence(0.3),
      tone(0.25),
      silence(0.3),
      tone(0.25),
      silence(0.2),
    );
    const segments = segmentSyllables(samples, SAMPLE_RATE);
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.syllablePosition)).toEqual([0, 1, 2]);
    // strictly increasing, non-overlapping, in recording order
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startTimeSeconds).toBeGreaterThan(segments[i - 1].endTimeSeconds);
    }
  });

  it('bridges a brief internal dip instead of splitting one syllable into two', () => {
    // A stop consonant's closure: energy drops briefly but not for as
    // long as a real inter-syllable pause.
    const samples = concat(silence(0.2), tone(0.15), silence(0.05), tone(0.15), silence(0.2));
    const segments = segmentSyllables(samples, SAMPLE_RATE, { minSilenceGapSeconds: 0.15 });
    expect(segments).toHaveLength(1);
  });

  it('splits into two when the internal gap is a real pause, not a brief dip', () => {
    const samples = concat(silence(0.2), tone(0.15), silence(0.3), tone(0.15), silence(0.2));
    const segments = segmentSyllables(samples, SAMPLE_RATE, { minSilenceGapSeconds: 0.15 });
    expect(segments).toHaveLength(2);
  });

  it('discards a spurious blip shorter than a real syllable', () => {
    const samples = concat(
      silence(0.2),
      tone(0.01, 0.9), // a click/pop - louder than the threshold but too brief to be real
      silence(0.3),
      tone(0.25, 0.9), // an actual syllable
      silence(0.2),
    );
    const segments = segmentSyllables(samples, SAMPLE_RATE, { minSegmentDurationSeconds: 0.04 });
    expect(segments).toHaveLength(1);
  });

  it('gives a louder segment higher confidence than a quieter one', () => {
    // Both bursts clearly above minConfidence - this tests relative
    // ordering, not the low-confidence filter (see the dedicated test
    // below for that).
    const samples = concat(silence(0.2), tone(0.25, 0.5), silence(0.3), tone(0.25, 0.9), silence(0.2));
    const segments = segmentSyllables(samples, SAMPLE_RATE);
    expect(segments).toHaveLength(2);
    expect(segments[1].confidence).toBeGreaterThan(segments[0].confidence);
  });

  it('filters out a low-confidence blip (e.g. a breath sound) even if it clears the duration filter', () => {
    // Validated against real recordings (see app/README.md) - a breath/
    // click clears the voicing threshold and minSegmentDurationSeconds,
    // but sits at a distinctly lower relative energy than genuine speech.
    const samples = concat(
      silence(0.2),
      tone(0.1, 0.15), // quiet enough to be a breath/click, not real speech
      silence(0.3),
      tone(0.25, 0.9), // an actual syllable
      silence(0.2),
    );
    const segments = segmentSyllables(samples, SAMPLE_RATE);
    expect(segments).toHaveLength(1);
    expect(segments[0].confidence).toBeGreaterThanOrEqual(0.3);
  });

  it('adapts to the recording\'s own noise floor rather than assuming a fixed absolute level', () => {
    // Same protocol, but recorded "quieter" overall (lower amplitude tone,
    // some ambient noise) - should still segment correctly since the
    // threshold is relative to this recording's own levels.
    const samples = concat(
      silence(0.2, 0.01),
      tone(0.25, 0.15),
      silence(0.3, 0.01),
      tone(0.25, 0.15),
      silence(0.2, 0.01),
    );
    const segments = segmentSyllables(samples, SAMPLE_RATE);
    expect(segments).toHaveLength(2);
  });

  it('returns an empty array for an empty buffer', () => {
    expect(segmentSyllables(new Float32Array(0), SAMPLE_RATE)).toEqual([]);
  });
});

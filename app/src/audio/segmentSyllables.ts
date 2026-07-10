// segmentSyllables.ts
//
// Client-side syllable-boundary detection for the "syllables spoken with
// deliberate pauses" recording (the second of the two takes per
// word/speaker - see REMOTE_ACCESS_DISCUSSION.md's "Audio pipeline"
// section and app/README.md). Deliberately a plain amplitude/energy
// threshold detector, not a trained VAD model: the two-recording protocol
// turns "find syllable boundaries in continuous natural speech" (hard -
// why Silero VAD exists) into "find N silence gaps in a recording where
// the speaker was told to pause between syllables" (much easier), so
// there's no a-priori reason to reach for a model before establishing the
// simple approach isn't enough. If it isn't, @ricky0123/vad (the actual
// Silero VAD model via ONNX Runtime Web/WASM, still entirely client-side)
// is a drop-in replacement behind this same function's contract.
//
// Deliberately operates on already-decoded PCM (Float32Array + sampleRate),
// not a MediaRecorder Blob or an AudioContext - decoding a recording to PCM
// requires a real browser (AudioContext.decodeAudioData), which can't be
// unit-tested here. Keeping that decode step as a thin, separate wrapper
// around this pure function means the actual segmentation logic - the part
// that can silently get boundaries wrong - is fully testable with
// synthetic sample data, in Node, without a browser at all.

export interface SyllableSegment {
  /** 0-indexed position within the recording - NOT yet matched against the
   * word's expected syllable list; that comparison (and what to do on a
   * count mismatch) is the caller's job, not this function's. */
  syllablePosition: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  /** 0-1, this segment's average energy normalized against the
   * recording's own noise floor and peak level - not a probability, just
   * a relative confidence signal for the review UI. */
  confidence: number;
}

export interface SegmentSyllablesOptions {
  /** Analysis frame size. Shorter frames find boundaries more precisely
   * but are noisier; 20ms is a conventional speech-processing default. */
  frameSizeSeconds?: number;
  /** How far to advance between frames. Smaller than frameSizeSeconds
   * means overlapping frames - smoother detection, more compute. */
  hopSizeSeconds?: number;
  /** Segments shorter than this are discarded as spurious (a click, a
   * breath, a stray noise) rather than treated as a real syllable. */
  minSegmentDurationSeconds?: number;
  /** Silence gaps shorter than this get bridged - merges two voiced
   * regions into one segment rather than splitting a single syllable in
   * two at a brief energy dip (e.g. a stop consonant's closure). */
  minSilenceGapSeconds?: number;
  /** Where the voiced/silent threshold sits between the recording's own
   * noise floor and peak level (0 = at the noise floor, 1 = at the peak).
   * Relative to the recording's own levels, not an absolute amplitude, so
   * it adapts to mic gain/recording volume rather than assuming one fixed
   * loudness. */
  thresholdFactor?: number;
  /** A recording that's just ambient noise throughout (no real speech at
   * all) still has SOME gap between its own noise-floor and peak-level
   * estimates - pure sampling variance in the RMS estimate, not a real
   * loud/quiet distinction. Below this peak-to-floor ratio, the recording
   * is treated as having no real signal at all and zero segments are
   * returned, rather than the relative threshold finding "structure" in
   * what's actually homogeneous noise. */
  minPeakToFloorRatio?: number;
  /** A second, absolute guard for the same case: if the peak level itself
   * never rises above this (near-silence throughout, including true
   * digital silence where noiseFloor and peakLevel are both exactly 0 and
   * the ratio check above can't distinguish "no signal" on its own),
   * there's nothing to segment. */
  minAbsolutePeakLevel?: number;
  /** Segments below this confidence are discarded - validated against
   * real recordings (see app/README.md's testing note): breath sounds and
   * mouth clicks before/between real speech clear the voicing threshold
   * and pass the duration filter, but sit at a distinctly lower relative
   * energy (~0.2-0.25 in real test recordings) than every genuine
   * syllable/word observed (~0.4-0.9) - a real, well-separated gap, not
   * an arbitrary cutoff. */
  minConfidence?: number;
}

const DEFAULT_OPTIONS: Required<SegmentSyllablesOptions> = {
  frameSizeSeconds: 0.02,
  hopSizeSeconds: 0.01,
  minSegmentDurationSeconds: 0.04,
  minSilenceGapSeconds: 0.15,
  thresholdFactor: 0.15,
  minPeakToFloorRatio: 1.5,
  minAbsolutePeakLevel: 0.005,
  minConfidence: 0.3,
};

interface Frame {
  startTimeSeconds: number;
  energy: number;
}

function computeFrameEnergies(
  samples: Float32Array,
  sampleRate: number,
  frameSizeSeconds: number,
  hopSizeSeconds: number,
): Frame[] {
  const frameSize = Math.max(1, Math.round(frameSizeSeconds * sampleRate));
  const hopSize = Math.max(1, Math.round(hopSizeSeconds * sampleRate));
  const frames: Frame[] = [];

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let sumSquares = 0;
    for (let i = start; i < start + frameSize; i++) {
      const s = samples[i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / frameSize);
    frames.push({ startTimeSeconds: start / sampleRate, energy: rms });
  }

  return frames;
}

function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[mid - 1] + sortedValues[mid]) / 2
    : sortedValues[mid];
}

/** Robust noise-floor/peak-level estimate from the frame energies
 * themselves, so the threshold adapts to this specific recording's own
 * loudness rather than assuming a fixed absolute level - a quiet mic and a
 * loud one should both segment correctly. */
function estimateLevels(frames: Frame[]): { noiseFloor: number; peakLevel: number } {
  const sorted = [...frames.map((f) => f.energy)].sort((a, b) => a - b);
  if (sorted.length === 0) return { noiseFloor: 0, peakLevel: 0 };

  const bottomHalf = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  const topTenPercentStart = Math.max(0, sorted.length - Math.ceil(sorted.length * 0.1));
  const topSlice = sorted.slice(topTenPercentStart);

  return {
    noiseFloor: median(bottomHalf),
    peakLevel: median(topSlice),
  };
}

export function segmentSyllables(
  samples: Float32Array,
  sampleRate: number,
  options: SegmentSyllablesOptions = {},
): SyllableSegment[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const frames = computeFrameEnergies(samples, sampleRate, opts.frameSizeSeconds, opts.hopSizeSeconds);
  if (frames.length === 0) return [];

  const { noiseFloor, peakLevel } = estimateLevels(frames);

  const hasRealSignal =
    peakLevel >= opts.minAbsolutePeakLevel && peakLevel >= noiseFloor * opts.minPeakToFloorRatio;
  if (!hasRealSignal) return [];

  const threshold = noiseFloor + (peakLevel - noiseFloor) * opts.thresholdFactor;
  const frameDuration = opts.frameSizeSeconds;

  // 1. Raw voiced/silent runs.
  type RawSegment = { start: number; end: number; energies: number[] };
  const raw: RawSegment[] = [];
  let current: RawSegment | null = null;

  for (const frame of frames) {
    const voiced = frame.energy > threshold;
    const frameEnd = frame.startTimeSeconds + frameDuration;
    if (voiced) {
      if (current) {
        current.end = frameEnd;
        current.energies.push(frame.energy);
      } else {
        current = { start: frame.startTimeSeconds, end: frameEnd, energies: [frame.energy] };
      }
    } else if (current) {
      raw.push(current);
      current = null;
    }
  }
  if (current) raw.push(current);

  // 2. Bridge short silence gaps between voiced runs (a stop consonant's
  // closure shouldn't split one syllable into two).
  const bridged: RawSegment[] = [];
  for (const seg of raw) {
    const prev = bridged[bridged.length - 1];
    if (prev && seg.start - prev.end < opts.minSilenceGapSeconds) {
      prev.end = seg.end;
      prev.energies.push(...seg.energies);
    } else {
      bridged.push({ ...seg, energies: [...seg.energies] });
    }
  }

  // 3. Discard spurious blips: too short to be a real syllable, or too
  // low-confidence (a breath/click clears the voicing threshold and the
  // duration filter, but sits well below any genuine syllable's energy -
  // see minConfidence's docs). Only assign final order after both filters,
  // so syllablePosition reflects the real syllables, not raw candidates.
  const peakRange = Math.max(peakLevel - noiseFloor, 1e-9); // avoid divide-by-zero on a silent/flat recording
  return bridged
    .filter((seg) => seg.end - seg.start >= opts.minSegmentDurationSeconds)
    .map((seg) => {
      const avgEnergy = seg.energies.reduce((a, b) => a + b, 0) / seg.energies.length;
      const confidence = Math.min(1, Math.max(0, (avgEnergy - noiseFloor) / peakRange));
      return { start: seg.start, end: seg.end, confidence };
    })
    .filter((seg) => seg.confidence >= opts.minConfidence)
    .map((seg, index) => ({
      syllablePosition: index,
      startTimeSeconds: seg.start,
      endTimeSeconds: seg.end,
      confidence: seg.confidence,
    }));
}

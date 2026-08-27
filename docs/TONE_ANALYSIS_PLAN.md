# Yoruba tone analysis and audio preparation plan

## Purpose

Build one reproducible pipeline with two deliberately separate outputs:

1. **Analysis audio and measurements** preserve the captured signal. Tone measurements are
   computed from decoded raw audio, never from loudness-normalized game assets.
2. **Delivery audio** is tightly and consistently clipped, faded, loudness-normalized, and
   peak-limited for games and other listening contexts. Raw audio remains immutable.

An output is never silently substituted for its source. Every derived file has a manifest
containing the source digest, processor/version, complete parameters, measurements before and
after processing, and quality flags.

## Questions and measurable outputs

### Speaker tonal systems

- Estimate each speaker's balanced tonal centre and H/M/L distributions in Hz, semitones from
  that centre, and within-speaker z-scores.
- Estimate prototype contours at normalized syllable time points rather than reducing a tone to
  one pitch value.
- Measure H-M, M-L, and H-L intervals, within-tone variance, contour slope/curvature, and usable
  pitch range.
- Fit speaker and word as varying effects so word inventory does not masquerade as a speaker
  difference.

### Contextual realization

- Group observations by preceding/current/following tone, syllable position, word length, vowel,
  and relevant consonant environment.
- Test carry-over, anticipation, downstep, declination, range compression, and target undershoot.
- Compare the same segmental syllable across words and tones where coverage permits.

### Natural versus careful speech

- Treat take 1 as `natural_word` and take 2 as `careful_syllables`; migrate away from relying on
  take numbers as semantic labels.
- Preserve the existing silence-gap intervals for take 2.
- Add automatic alignment intervals for take 1, with provenance and optional manual corrections.
- Compare paired contours, tone intervals, durations, transition timing, range, and classifier
  agreement. Do not create publishable syllable clips from uncertain take-1 alignment by default.

### Review candidates and future learner feedback

- First produce explainable review candidates: unreliable pitch, possible octave error, low
  voicing coverage, unexpected tone category, compressed range, or natural/careful disagreement.
- Calibrate every threshold against fluent-speaker adjudication.
- A model must abstain on poor signal or insufficient reference coverage.
- Learner-facing feedback comes only after held-out validation. It reports specific observations,
  not a context-free pronunciation verdict.

## Architecture

The initial implementation lives in `analysis/` in this repository because recording semantics,
schema, curator UI, and the acoustic pipeline are still co-evolving. It is a standalone Python
package with no runtime coupling to the web request path.

```text
Postgres raw audio + frozen pronunciation metadata
                    |
             versioned batch export
                    |
        decode and source-quality audit
             /                    \
 raw waveform tone path      delivery conditioning path
     |                               |
 alignment -> F0 -> features    trim -> fade -> loudness -> peak ceiling
     |                               |
 observations/profiles          game-ready WAV + manifest
             \                    /
             Postgres summaries/artifact references
                    |
          curator reports and product APIs
```

The package boundary should remain usable against a WAV file, an exported directory, or database
rows. Database access is an adapter, not part of the DSP core.

## Audio preparation requirements

### Source handling

- Never overwrite `raw_audio_data` or `raw_blob_path`.
- Decode all accepted capture formats to a documented working format. Preserve the source digest.
- Use mono floating-point PCM internally. Explicitly document channel folding and sample-rate
  conversion.
- Reject or flag truncated files, decoding errors, DC offset, hard clipping, very low signal,
  excessive noise, and insufficient speech.

### Trimming

- Detect active speech with adaptive frame energy and hysteresis; do not use a fixed absolute
  threshold.
- Bridge short internal gaps so stop closures do not split syllables.
- Add configurable leading/trailing context; defaults differ for whole words and syllable clips.
- Move cut points toward a local zero crossing, then apply short equal-power or linear fades.
- Never trim an uncertain file to nothing. Abstain and retain the input for review.
- Store both detected speech bounds and final padded cut bounds.

### Loudness and peaks

- Production game assets target integrated loudness (ITU-R BS.1770 / EBU R128 semantics), with a
  configurable target and true-peak ceiling. Use two-pass measurement/application so manifests
  contain both measurements.
- Very short syllable clips require special handling: integrated LUFS is unstable or undefined.
  Use the configured short-clip policy (gated RMS calibrated against the game corpus, or normalize
  at a containing-word/group level), and label the method honestly in the manifest.
- Do not apply dynamic-range compression by default. A gain ceiling prevents amplified noise;
  peak limiting must be separately visible in the manifest.
- Tone extraction always uses raw decoded samples; gain normalization is for delivery only.

### Delivery profiles

- `analysis`: lossless decoded PCM, no gain or trimming beyond explicitly requested analysis
  intervals.
- `game_word`: conservative padding, consistent loudness, true-peak ceiling.
- `game_syllable`: shorter padding/fades and the short-clip normalization policy.
- Profiles are named, versioned configuration—not scattered constants.

## Data changes

Add these in migrations only after the file-based contract is exercised:

- `utterances.recording_style`: `natural_word | careful_syllables` (backfill take 1/2).
- `recording_sessions`: session time, capture client, device/browser hints, and environment notes.
- `audio_analysis_runs`: immutable run identity, software version, config JSON, start/end/status.
- `audio_artifacts`: source entity, purpose/profile, content digest, storage reference, format, and
  manifest JSON.
- `syllable_intervals`: start/end, source (`pause_detector`, `forced_alignment`, `manual`), version,
  confidence, and supersession history.
- `syllable_acoustic_features`: F0 summaries/contour, duration, voicing, intensity, quality flags,
  and analysis run.

Pitch tracks are too large and rebuildable for ordinary relational columns. Store compressed
columnar artifacts and keep summaries plus references in Postgres.

## Implementation phases and gates

### Phase 0 — corpus audit

- Inventory codecs, sample rates, channels, durations, clipping/noise, take pairing, speaker/tone
  balance, and incomplete metadata.
- Hand-label trimming bounds and obvious quality issues for a stratified evaluation set.
- Gate: the evaluation set represents each speaker, recording style, device family, and common
  failure mode available.

### Phase 1 — audio conditioning foundation

- File-oriented CLI, immutable manifests, source-quality metrics, adaptive trimming, zero-crossing
  refinement, fades, delivery profiles, loudness/peak normalization, and deterministic tests.
- Gate: no clipped phonemes in the hand-labelled set; cut error and loudness/peak tolerances are
  published; re-running the same source/config is byte- and manifest-stable where codecs allow.

### Phase 2 — acoustic extraction

- Praat/Parselmouth-based F0 with speaker-adaptive floors/ceilings, octave correction, voicing
  gates, normalized-time contours, tone parsing, and feature tables.
- Gate: manually inspect stratified pitch tracks; measure octave errors and abstention rate.

### Phase 3 — paired and speaker profiles

- Take-1 alignment, paired natural/careful reports, H/M/L profiles, contextual summaries, and
  hierarchical exploratory models with uncertainty intervals.
- Gate: leave-one-word-out and leave-one-speaker-out checks; minimum coverage shown on every chart.

### Phase 4 — platform integration

- Versioned DB tables/artifacts, safe batch jobs, curator audio-QA queue, speaker and word reports.
- Gate: jobs are restartable/idempotent, raw bytes never change, and curator actions are audited.

### Phase 5 — teaching experiments

- Tone-range diagnostics, contextual exercise ordering, native-reference bands, perception tasks,
  and carefully worded production feedback.
- Gate: fluent-speaker review plus learner pilot; no single opaque score and no verdict on an
  abstained sample.

## Immediate vertical slice

The first code slice provides a dependency-light WAV conditioning core and deterministic manifest.
It establishes trimming, padding, zero-crossing, fading, gain/peak safety, and quality metrics while
the standards-compliant BS.1770 backend and capture-format decoder remain explicit follow-up work.
The fallback RMS normalizer must identify itself as `rms_dbfs`, never as LUFS.

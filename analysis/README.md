# analysis

Offline, reproducible acoustic analysis and audio-asset preparation for the Yoruba dictionary.
See [`docs/TONE_ANALYSIS_PLAN.md`](../docs/TONE_ANALYSIS_PLAN.md) for the architecture and gates.

The initial CLI accepts uncompressed mono/stereo PCM WAV without third-party dependencies:

```sh
cd analysis
python3 -m tone_lab.cli prepare input.wav output.wav --profile game-word
python3 -m tone_lab.cli legacy-audit ../yoruba-student-dict ./build/legacy-audit
python3 -m tone_lab.cli legacy-tone-report ../yoruba-student-dict ./build/legacy-tone-report
python3 -m tone_lab.cli legacy-speaker3-natural-report ../yoruba-student-dict ./build/speaker3-natural
python3 -m unittest discover -s tests
```

It preserves the input, writes a processed WAV, and writes `output.wav.json` containing source and
output hashes, processing parameters, bounds, measurements, and flags. The current normalizer is an
explicit RMS fallback. It is not represented as LUFS; the planned production backend will use
BS.1770 integrated loudness and true-peak measurement.

Deprecated directory layouts and filename rules are confined to `tone_lab.legacy`. The generic
audit and audio modules consume forward-looking `CorpusAudioRecord` values and know nothing about
safe-name suffixes. Legacy syllable reports explicitly retain ambiguous provenance.

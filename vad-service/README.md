# vad-service/ (deferred, not part of v1)

Originally planned as a Python Container App running Silero VAD segmentation
(ported from `yoruba-student-dict/content/parse_word_syllable_audio.py`).
**Decided against for v1** in favor of client-side segmentation - see
`yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md`'s "Audio pipeline" section
for the full reasoning. Short version:

- Recording protocol is two separate takes per word/speaker: a clean
  whole-word recording (no segmentation needed at all) plus a second take
  where the speaker deliberately pauses between syllables. That turns
  "find syllable boundaries in continuous natural speech" (genuinely hard -
  why Silero VAD, a trained model, exists) into "find N silence gaps",
  where N and the expected syllable order are already known in advance from
  `golden_record.syllables`.
- v1's segmenter is plain client-side JS in `app/` (Web Audio API: decode
  to PCM, amplitude/energy threshold over sliding windows) - see that
  package's README.
- The upgrade path stays open and cheap without ever needing this
  container: `@ricky0123/vad` runs the actual Silero VAD model via ONNX
  Runtime Web/WASM, entirely client-side, if the simple approach's
  `flagged_for_review` rate proves too high in practice.

This directory is kept as a placeholder for that later option (or for the
still-deferred acoustic canonical-recording-selection algorithm, which may
end up needing real Python/`parselmouth`) - not built now.

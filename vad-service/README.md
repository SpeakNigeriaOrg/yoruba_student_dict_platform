# vad-service/

Python, containerized (Azure Container Apps) - Silero VAD syllable
segmentation, ported from
`yoruba-student-dict/content/parse_word_syllable_audio.py` with its
segmentation logic unchanged. Deliberately NOT ported to JS/TS - PyTorch and
Silero VAD have no reasonable JS equivalent, and this runs as an
offline/async batch job (triggered per-`Utterance` on upload), not part of
the live interactive request path - so it's exempt from the client-side-JS
reasoning that applies to `shared/`.

## What's different from the local version

The local script (`parse_word_syllable_audio.py`) computes Silero VAD
segment timing and confidence internally and then discards it, writing only
plain `.wav` files - see
`yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md`'s audio-storage design.
This service must instead:

- Write one row per extracted syllable clip to `SyllableObservations`
  (`start_time_s`, `end_time_s`, `vad_confidence` populated - not discarded),
  never skip-if-exists - every take from every speaker is preserved, since
  syllable identity now lives in the database (`syllable_text` + generated
  tone/orthography-insensitive columns), not in a deduplicating filename.
- Write the resulting audio clip to Blob Storage at an opaque
  `syllables/{observation_id}.wav` path - no word/speaker/syllable info
  encoded in the path itself.
- Update the parent `Utterances` row's `status` (`segmented` or
  `flagged_for_review`) rather than a flat CSV report.

See `../db/` for the schema this writes to.

Not yet scaffolded with an actual Dockerfile/container tooling - placeholder
pending the first real implementation pass.

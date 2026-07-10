# app/

React (Vite + TypeScript) frontend, deployed to Azure Static Web Apps.

Responsibilities (see the repo root README and
`yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md` for the full design):

- Fetch the vocabulary/diagnostics data and run `shared/`'s matching engine
  client-side for live preview/search - no Azure Function round-trip needed
  for read-only operations, since that logic is pure and doesn't require
  server trust.
- Three curator-facing review surfaces (mirroring the local tool's three
  tabs: Definitions, Spelling & Tone, Etymology), plus new screens not in
  the local tool: a per-user assignment view ("mine" / "unassigned pool" /
  "everything" for the curator role), a volunteer-contribution review
  queue, and an audio recorder.
- **Audio recorder + client-side segmentation** (see
  `REMOTE_ACCESS_DISCUSSION.md`'s "Audio pipeline" section - this is where
  `vad-service/`'s originally-planned Container App decision was
  reconsidered): captures two takes per word/speaker via `MediaRecorder`
  (a clean whole-word recording, and a second take with deliberate pauses
  between syllables), decodes the second take to PCM via
  `AudioContext.decodeAudioData`, and finds syllable boundaries with a
  plain amplitude/energy-threshold detector over the known, expected
  syllable count/order (`golden_record.syllables`) - no VAD model needed
  for v1. Upgrade path if needed later: `@ricky0123/vad` (real Silero VAD
  via ONNX Runtime Web/WASM), swappable behind the same `AudioBuffer in,
  {syllablePosition, startTime, endTime, confidence}[] out` contract.
  Segmented clips upload directly to Blob Storage via a short-lived SAS
  token (from a small `api/` Function), then a second small Function call
  registers the resulting rows in Postgres.
- Login via Azure SWA's built-in auth (EasyAuth); role-gated views driven by
  the `x-ms-client-principal` identity SWA injects.

## Status

Scaffolded (Vite + React + TS + Vitest, `npm run dev`/`build`/`test` all
work). The one real piece of logic built so far is
`src/audio/segmentSyllables.ts` - the amplitude/energy-threshold syllable
segmenter described above.

**Validated against real recordings**, not just synthetic test tones:
`yoruba-student-dict/content/incoming/*.mp4` (raw recordings: whole word,
pause, syllables enunciated - all one continuous take, an already-real
precedent for exactly the segmentation task this module does, decoded via a
pip-installed static ffmpeg since no system ffmpeg/Homebrew was available in
this environment) against ground truth read from
`yoruba-student-dict/content/processed/<word>/` (the count of already-cut
syllable `.wav` files per word - not `content/segmentation_report.csv`,
whose rows can't be reliably string-matched to filenames due to Unicode
normalization differences, the same class of issue documented elsewhere in
this project). 5/5 real recordings tested now segment to the exact correct
count. This caught one real bug worth recording: a breath/click before
speech starts clears the voicing threshold and the minimum-duration filter,
but sits at a distinctly lower relative energy (~0.2-0.25) than every
genuine syllable/word observed across all 5 recordings (~0.4-0.9) - fixed
by adding `minConfidence` (default 0.3), not by adding a workaround for
just that case.

The real audio files/decoded PCM used for this validation were **not
committed** (a teacher's actual voice recordings - worth an explicit
decision, not an assumed one, before real voice data goes into version
control). If permanent real-audio regression fixtures are wanted later,
that's worth deciding deliberately rather than defaulting into it.

Not yet built: the actual React screens (still just a placeholder `App.tsx`
shell), the `MediaRecorder` capture UI, and the `AudioContext.decodeAudioData`
browser-integration wrapper around the segmenter - none of that can be
verified without a real browser, unlike the segmentation algorithm itself.

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

Not yet scaffolded with actual Vite tooling - this is a placeholder pending
the first real implementation pass.

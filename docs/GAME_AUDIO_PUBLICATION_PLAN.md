# Game audio publication plan

## Boundary and invariants

Recording capture, curation, processing metadata, and publication planning belong in this
repository while those contracts are evolving together. Games remain consumers: they receive
versioned media plus manifests and do not trim, normalize, select, or infer coverage themselves.

The pipeline has four distinct states:

1. **Raw observation** — immutable upload bytes and frozen pronunciation metadata.
2. **Derived artifact** — decoded, trimmed, faded, normalized delivery WAV plus measurements,
   processor version, profile, source digest, and quality flags.
3. **Selected exemplar** — the artifact chosen for a logical game slot.
4. **Release** — a complete set of selected artifacts and manifests promoted atomically.

## Capture formats

Capture is deliberately inclusive. The client asks MediaRecorder for Opus or AAC in a preferred
order, but falls back to the browser's native default rather than rejecting a volunteer's device.
It preserves that native Blob unchanged and uses the browser decoder to send an immediate PCM-WAV
delivery copy. Registration inspects byte signatures, records the declared MIME type only as
provenance, caps each payload at 15 MB, and refuses a delivery copy that is not PCM WAV.

The browser copy is useful immediately but is not the trusted final artifact. Run:

```sh
DATABASE_URL=postgres://... npm run audio:process -- --apply
```

on a worker with `ffmpeg` and `ffprobe` installed. The worker inspects the real stream and codec,
requires one audio stream and no video/data streams, bounds duration, decodes the immutable raw
capture, conditions it, writes mono 48 kHz PCM WAV, and records source/output hashes, tool versions,
measurements, and its manifest. The upload boundary recognizes the browser recording containers we
support—WebM, Ogg, MP4, and WAV—from their bytes; the worker then uses ffprobe/ffmpeg to determine
and validate the codec inside that container. A declared MIME type is never treated as proof of a
codec.

Analysis always reads raw decoded audio. Delivery conditioning never becomes the source for tone
measurements. Publication never overwrites raw bytes and never treats an upload filename or its
declared MIME type as proof of the actual codec.

## Canonical syllables

“Canonical” means a **preferred game exemplar for one speaker**, not a universal or prescriptive
Yoruba pronunciation. The logical identity is:

`speaker_id + exact NFC tone-marked syllable + delivery profile`

The originating word is provenance, not identity, because the current games reuse an isolated
syllable across words. Every observation remains available for acoustic analysis and later
reselection.

Selection order is:

1. a valid curator selection;
2. an automatically recommended artifact that passes the profile's quality gates;
3. a stable transitional fallback (newest recording, then observation UUID).

The fallback exists to make today's corpus publishable and reproducible. It is not an acoustic
quality judgment. Automatic recommendation should eventually rank clipping/noise/trim flags,
voicing coverage, target-tone fit, natural/careful agreement, and distance from the speaker's
robust prototype. Low-confidence or near-tied candidates should be sent to review.

## Processing placement

Conditioning runs as an asynchronous batch immediately after raw capture or backfill and before an
artifact can be selected. It must also be runnable locally for corpus repair and profile testing.
The same versioned DSP core and profiles serve both contexts; only the database/storage adapter
differs.

For each source, the worker:

1. identifies and decodes the actual container/codec;
2. audits source quality;
3. produces mono PCM working audio;
4. applies profile-specific speech trimming, padding, zero-crossing cuts, and fades;
5. applies the declared short-clip or word loudness policy and peak ceiling;
6. measures the result and writes an immutable manifest;
7. promotes the artifact to `ready` only if validation passes.

The existing `analysis/` CLI is the forward-looking DSP core. Anything under
`analysis/src/tone_lab/legacy/` is only an adapter for deprecated corpora and must not be imported
by the production worker.

## Publication transaction

Both local export and R2 publication use `shared/gamePublishing` for identity, selection, coverage,
filenames, and level planning. A release must be deterministic for the same database snapshot.

Remote publication stages content-addressed objects, verifies every expected object, writes all
manifests under a new release identifier, and only then changes the small active-release pointer.
Pruning happens after promotion and retains at least the previous release for rollback. Any failed
upload or verification aborts promotion and pruning.

The current R2 script now enforces the most important transitional safety rule: a failed object
stops manifest rewriting and orphan deletion. Content-addressed staging and an active-release
pointer are the next step before this should be considered fully atomic.

## Rollout

1. Use speaker 3 as the canary because its natural word and isolated syllable recordings follow
   current database conventions.
2. Run a read-only inventory and conditioning preview; compare duration, cut bounds, RMS/peak,
   clipping, and flags before and after.
3. Materialize artifacts without changing current selections and compare proposed coverage and
   manifests with the existing release.
4. Enable automatic fallback selection for speaker 3, then listen to a stratified sample in the
   game.
5. Promote a versioned speaker-3 release, retain the prior release, and exercise rollback.
6. Expand to current-pipeline speakers; keep legacy imports explicitly labeled and out of automatic
   publication unless migrated.

## Completion gates

- Identical inputs and configuration produce identical selections and manifests.
- A null, failed, unverified, or quality-rejected artifact cannot appear in coverage.
- API coverage and publisher coverage agree exactly, including cross-word syllable reuse.
- No upload failure can change the active release or trigger pruning.
- Every served audio object is a valid WAV with matching content type and recorded measurements.
- Raw bytes remain unchanged through reprocessing and profile upgrades.
- A curator can see why an exemplar was selected and replace it without deleting observations.

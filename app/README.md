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

## `staticwebapp.config.json` lives in `public/`, not the platform repo root

Confirmed against current Microsoft Learn docs while prepping for
deployment: Azure requires this file to end up at the root of the
`output_location` after the build runs - there's no separate "config file
path" setting to point elsewhere. `public/staticwebapp.config.json` is
Vite's standard way to get a file copied verbatim into `dist/` at build
time (confirmed: `npm run build` puts it in `dist/staticwebapp.config.json`).
It used to live at the platform repo root, where Azure's build would never
have actually picked it up.

## Writing Yoruba without a Yoruba keyboard

Two screens need a contributor to produce `ẹ ọ ṣ` and tone marks, and neither can assume
the device does. The answer is the same in both, and it is deliberately not a full keypad:

**Tone is never typed.** `ToneGrid` renders one column per syllable and one row per tone,
and *generates* the diacritic - so a malformed mark is not merely discouraged, it is
unreachable. That leaves only the underdotted letters as a typing problem.

**Six keys cover the rest.** `ẹ ọ ṣ` and their capitals `Ẹ Ọ Ṣ` (`yorubaLetters.ts`). The
capitals are not a nicety: they are distinct codepoints, not a shift state a device can
synthesise, and a sentence example like `Ọ̀pọ̀lọ́ ń fò` begins with one.

It also degrades upward. Someone who has Keyman installed and types the phrase fully
marked gets the grids pre-filled from what they wrote, so the tone step becomes a
confirmation rather than re-entry.

`PhraseComposer` applies this per word (`phraseWords.ts` splits and rejoins, peeling
punctuation so a *sentence* example still gets a grid on its last word). Its text field
holds the composed phrase and is the only state - what the contributor reads is exactly
what gets stored.

### One thing tone buttons alone could not say

A nasal after a vowel is either a **coda** nasalising that vowel or a **syllable of its own**,
and bare spelling does not always settle it: `alangba` is `a·lan·gba` or `a·la·n·gba`. Tone goes
on a syllable's vowel when it has one, so the three buttons over `lan` write `làn`/`lan`/`lán`
and never touch the `n` — there was **no sequence of taps that reached `aláǹgbá`**. The right
answer was unreachable, not merely non-default, which is the worst shape this kind of gap can
take: every recorded vote agreed with the default because the default was all there was.

So `ToneGrid` carries one more control, on the one column where the ambiguity is live. Freeing a
nasal **writes the macron at the same time**, and that is the whole trick:

```
alangba   a │ lan │ gba   ──▶   alan̄gba   a │ la │ n̄ │ gba   ──▶   aláǹgbá
                 "split off n"                    tone it like any syllable
```

`syllabifyWord('alan̄gba')` returns exactly `['a','la','n̄','gba']`, so the new split is
re-derivable from the new spelling. That matters because nothing stores a boundary the spelling
does not imply: `EntryReview` seeds its rows from `syllabifySpans(displayText)`, not from
`golden_record.syllables`, and `PhraseComposer` holds only the composed text. A boundary nobody
could re-derive would be invisible on the next load and silently overwritten — taking that word's
recordings out of the game with it.

The rules live in `shared/src/syllabify.ts`; `nasalSplit.ts` builds each candidate and then
**re-derives it** to check, returning null unless it comes back identical. So a rule added to the
splitter withdraws the offer here automatically, and a flip can never disagree with the splitter.

## A missing part is not a dead end

The etymology axis asks "what is this word made of?", and its component picker used to
search only `vocab-search` — our own ~90-word dictionary. A volunteer who knew `adìyẹ` is
part of `abo adìyẹ` was told to ask a curator, and **could not finish the task**. The
knowledge they had went nowhere.

The picker now searches the whole kaikki-yoruba corpus alongside the dictionary, words we
hold first and labelled. Picking one we do not hold does not add it — it queues a request
and returns the `word_id` that request will create, so the etymology submission proceeds
immediately. Three things make that safe:

- **The `word_id` is derived, not chosen** (`shared/src/deriveWordId.ts`). Two volunteers
  who pick the same etymology derive the same id, which is what lets the consensus tally
  score them as agreeing. A renameable id would fingerprint as a conflict.
- **It is never shown.** Chips read the word, plus "will be added once a curator approves".
  Showing the id would invite asking for a different one.
- **The server decides resolve-vs-request**, because only it sees production and the corpus
  together (`api/src/handlers/resolveOrRequestComponent.ts`). Picking an etymology a word
  already cites *resolves to that word* rather than queuing a duplicate — which is how all 80
  cited words behave, since the derivation reproduces the convention they were named by.

An etymology naming a not-yet-approved part is refused at confirmation by
`ComponentsNotFoundError`, which names it. That ordering constraint already existed; what
was missing was seeing it coming, so `ReviewQueue` lists each request with **which words are
waiting on it**.

Behind an explicit "it isn't in Wiktionary either" is the rare path: write the word with
`PhraseComposer`, give an English definition, no audio (this requests a dictionary entry,
not a pronunciation). It is stored with an **exempt** citation, which per `0014` is not a
gap but the durable record that the word awaits an upstream entry — and `ReviewQueue` now
lists exempt words so that record is findable when Wiktionary gains one.

## A review screen must never be answerable only one way

Every review surface has to offer a way to DISAGREE, not just a way to confirm. This
is a correctness rule, not a UX preference: a screen whose only action is agreement
does not merely irritate reviewers, it **corrupts the evidence**, because every
recorded vote says yes when yes is the only thing clickable. The consensus model
(`shared/src/consensus.ts`) exists to tally independent judgements, and it cannot do
that if the interface can only record one of them.

This has been got wrong once, by over-correcting in the other direction: an earlier
pass removed options that were inapplicable - "accept proposed components" offered on
a word with no proposal, "adopt Kaikki's spelling" showing the same word as "keep our
spelling" - and left screens with a single button. Hiding a meaningless option is
right; leaving only agreement behind is not.

How each axis satisfies it now:

| Axis | How a reviewer disagrees |
|---|---|
| entry | The tone row is an **editor**, not a confirmation - every syllable's tone is one tap away on every word, and the letters sit behind "the letters are wrong" |
| etymology | Both "it has no parts" and "it does have parts" (which reveals the component picker, available to volunteers) |
| audio | Inherently generative - the act is contributing a recording, and the spelling and syllables being recorded against are both editable |
| example | Inherently generative - the contributor writes their own phrase. Nothing to agree or disagree with, and several different examples are the intended outcome rather than a conflict |

Each of those is covered by a named test in the corresponding `*.test.tsx`; search for
"agreement" to find them. Abstention is separate and already handled: the queue's
**Skip for now** records nothing, which is the honest way to say "I don't know".

## Status

A minimal but real curator flow is built and tested: identity
(`src/identity.ts`, reads SWA's `/.auth/me`), an assignments list
(`src/screens/AssignmentsList.tsx`, `GET /api/assignments/me`), and full
etymology reconciliation (`src/screens/EtymologyReview.tsx`,
`GET`/`POST /api/decisions/etymology` - both the forward
`componentsProposal` and the reverse `usedInProposal` this platform
surfaces for the first time). `src/api.ts` is the thin fetch layer both
screens use. Component tests (Vitest + `@testing-library/react`, jsdom)
use **real fixture data** - generated by calling the actual tested
handlers directly against real local Postgres, not invented shapes (see
`src/fixtures/`).

**Known limits, not glossed over**: there's no `func` CLI or real Azure
deployment in this development environment, so the actual SWA login
handshake and a live browser-to-Function-to-Postgres path remain
unverified until a real deployment exists - only the fetch/render/submit
logic itself is tested, against mocked (but realistically-shaped) `fetch`
responses.

Not yet built: spelling/definition axis decision UI (etymology only, for
now - see the approved plan for why), and the audio recorder pipeline
described below (`src/audio/segmentSyllables.ts` is the one piece of that
already built and tested).

The bulk curator assignment view is built: `AdminUsers.tsx` (every user
account plus assigned/in-review/passed counts, and an add-user form) and
`AdminUserDetail.tsx` (one user's assigned words, per-axis `AxisStatusBadges`
+ `AxisReviewBadges`, assign-more-words via `WordAssignPicker.tsx`, and
unassign).

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

Still not built: the `MediaRecorder` capture UI and the
`AudioContext.decodeAudioData` browser-integration wrapper around the
segmenter - neither can be verified without a real browser, unlike the
segmentation algorithm itself.

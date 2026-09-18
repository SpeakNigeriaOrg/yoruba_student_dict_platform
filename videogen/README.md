# videogen

Bulk, cartoon-style short-video generation and review for `word_videos`
(see `db/migrations/0028_word_videos.sql`) - the video sibling of
`imagegen/`, built to the same two-step, unattended-overnight shape:

```sh
cd videogen
uv sync
DATABASE_URL=postgres://... uv run python -m videogen.generate --video-style cartoon
# ... later, once candidates/ has output ...
DATABASE_URL=postgres://... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... \
  uv run python -m videogen.review --video-style cartoon
```

`generate.py` queries `golden_record` for words with no `word_videos` row
for `--video-style`, builds `--count` prompt variants per word (reusing
`imagegen`'s own scene-generation LLM step - see "Shared with imagegen"
below), and writes `candidates/{video_style}/{word_id}/v0.mp4`...`.mp4`
plus a `manifest.json`. `review.py` starts a local web server
(`http://localhost:4323`, loopback only) with the same toggle-select,
accept-several-in-one-pass grid `imagegen/review.py` has, adapted for
looping muted video thumbnails instead of static images.

## The one real architectural difference from images: no bytes in Postgres

`word_videos` has no `video_data` column at all - a 5s clip is multiple
MB, versus tens of KB for a PNG, and inlining that in Postgres the way
images/audio are was a deliberate no from the start of this branch (see
`0028_word_videos.sql`'s header). Instead:

- Accepting a candidate in `review.py` uploads its bytes straight to R2's
  `staging/videos/{style}/{word_id}/{sha256}.mp4` prefix (`r2.py`), THEN
  writes the `word_videos` metadata row (`blob_key` pointing at that
  staged object). This means `review.py` needs R2 credentials
  (`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
  `R2_BUCKET_NAME`), not just `DATABASE_URL` - a real new requirement
  `imagegen/review.py` never had.
- `scripts/publishToR2.mjs` (in the platform repo) promotes an accepted
  video from its staging key to its public key
  (`videos/{style}/{word_id}/{variant}.mp4`) with a server-side R2-to-R2
  copy, then deletes the staging copy - never re-uploading the bytes
  through Postgres or through this script, and never paying to store the
  same clip twice once it's published.

This preserves the same "accepted into the DB != published to the live
game" boundary images/audio already have - accepting a candidate here is
not itself a publish.

## Video is optional, never a gate

A word missing a video is a completely normal, expected, long-term state -
video coverage rolls out gradually, word by word. Unlike images (a hard
gate on the game export - see `exportGameContent.mjs`'s decision 7), no
level, no export, and no curator-facing check ever treats "no video" as a
problem. `vocab.json`'s `videos` map is simply `{}` for most words for a
long time.

## Shared with imagegen, not duplicated

`prompts.py` here is a thin wrapper, not a fork: `LocalLLMRewriter` (the
scene-generation and rewrite-for-divergence logic, Qwen3-8B) is imported
directly from `imagegen.prompts` (see `videogen/pyproject.toml`'s local
path dependency on `yoruba-imagegen`). That logic encodes several real,
hard-won fixes (category collapse, missing relationship context,
"diversity collapse" from templated prompting - see `imagegen/prompts.py`'s
own module docstring) that have nothing to do with images specifically; a
word's video needs the exact same "what should even be in frame" decision
an image does. The step video adds on top is `motion_directions` - see
the next section - which runs last, on the fully-decided still-frame
text, so motion phrasing never influences what the LLM decides the scene
itself should show.

Same two-strict-phases VRAM discipline as `imagegen/generate.py`: the LLM
is fully unloaded before the video model loads, for the same reason (see
"Model" below - there is no headroom to keep both resident). Both LLM
steps - scene generation and motion direction - run inside that same
resident phase, one word at a time, before anything is unloaded.

## Motion and sound: deciding what, if anything, moves or is heard

Video adds a genuinely new axis images never had, and it's a harder
problem than it first looks - see `prompts.py`'s module docstring for the
full argument. Short version: a word-blind default (fixed, gentle ambient
motion applied to every clip regardless of meaning) is wrong in both
directions at once. It's wrong for a word whose meaning literally IS a
motion ("bounce", "spin", "open") - those need to show that specific
action, which is the entire reason a video branch exists at all. And it's
wrong for a word whose meaning is a state or absence of activity ("sleep",
"wait", "silence") - animating one of those with any visible business
contradicts the word rather than just missing it.

`prompts.motion_and_sound_directions` treats this as its own real
decision, argued through in one LLM call per word (mirroring how
`illustration_scenes` argues through "what does this word show" rather
than trusting a bare category label - see that function's "Round 4" on
why a self-reported category field was rejected as unreliable). The same
call also decides each scene's sound (audio is generated jointly with
video by MiniMax H3 whether asked for or not, and it's kept, not
discarded - see "Model" below and `encode.py` - so leaving it purely to
the model's own guess across an unattended ~750-clip batch was a real
gap once that decision was made). Its system prompt lays out five cases,
in order of how much motion and sound they call for:

1. **The word's meaning IS an action, movement, process, or transition**
   (verbs of physical motion, or an event/transformation like break,
   arrive, finish) - the motion must depict THAT exact action as one
   clean, loopable cycle (a viewer should be able to guess the word from
   the motion alone, sound off), and the sound is a short concrete foley
   effect matching that exact action (a soft thud, a creak, a splash) -
   never music, never speech.
2. **The word names a relationship, exchange, or interaction between two
   parties** (give, share, greet, help, follow, teach) - the motion must
   show the interaction itself passing between them, not two static
   figures placed near each other; sound is a soft, indistinct
   interaction sound (a rustle, an unintelligible murmur) - never actual
   legible dialogue, since these are silent flashcard illustrations with
   no language to render as on-screen text.
3. **The word names a state, duration, or absence of activity** (sleep,
   wait, rest, silence, patience, calm) - deliberately minimal motion (a
   slow breath, a slow blink); sound matches with near-silence, at most a
   faint ambient tone, or literally "N/A". Genuine near-stillness is the
   correct answer here, not a fallback or a failure to find motion.
4. **The word is a quality or intensity with a natural tempo** (fast,
   slow, gentle, violent, happy, sad, excited) - the SPEED and ENERGY of
   an otherwise-ambient motion and its matching sound can carry the
   connotation (a quick snappy bounce with light quick taps for
   "fast"/"happy", a slow heavy settle with a low hum for "slow"/"sad")
   without depicting an unrelated action.
5. **Everything else** - ordinary nouns, categories, objects, places, and
   any word with no motion of its own - gets small ambient decorative
   motion (a gentle sway, a soft bob) and minimal or "N/A" sound. This is
   the default, and it covers most words; the point of the four cases
   above is catching the minority that need something else, not
   replacing this for everything.

In every case the model is told never to write music or legible dialogue
- those aren't this step's decision (see "MiniMax H3's own prompt format"
below on `non_diegetic_music`, hardcoded N/A always).

The taxonomy is instructions, not a field the model reports back and this
code trusts - it asks directly for the finished per-scene motion and
sound clauses, never a category name first, for the same reason
`illustration_scenes` stopped asking for a separate PERSON: self-report.
`styles.py`'s `motion_prompt`/`soundscape_prompt` are now only the
FALLBACK for when this LLM step fails or is skipped (`--no-llm`) -
written toward the case-5 ambient default, since a safe word-blind
fallback has to default to the common case, not the rarer "this word IS
an action" case that actually needs the real per-word decision to get
right.

## MiniMax H3's own prompt format

MiniMax H3 ships two prompt-writing guides in its own HF repo
(`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md`, `..._ref_en.md` - read in
full this session, not summarized secondhand). They document that the
model's rewrite pipeline expects a specific structured format, not one
free-form sentence: three top-level fields -
`integrated_multimodal_description`, `overall_soundscape`,
`non_diegetic_music` - with the visual field itself organized into
`[Shot N]` blocks (the first has no timestamp; a style statement comes
right at the start of `[Shot 1]`, before the scene content). The
reference-mode guide's own T2VA-vs-full-reference table confirms the
extra machinery it documents (`<Subject N>` labels, `<Audio N>`,
`retention_analysis`, multi-shot cut timestamps, speaker IDs and `<d>`
dialogue tags) is for reference/multi-shot narrative generation, none of
which applies to this pipeline: every clip here is a single 5s take with
no cuts, no reference image/video/audio input (`t2va`, text-only), and no
speech.

`prompts.compose_minimax_prompt` builds exactly the shape our clips
actually need - one `[Shot 1]` block (style stated first, independently
the same "style must come first" decision this pipeline already made for
still-frame prompts, see `apply_style` below) plus the two audio fields:

```
integrated_multimodal_description: [Shot 1] <style>, <scene>. <motion clause>
overall_soundscape: <sound clause, or "N/A">
non_diegetic_music: N/A
```

`non_diegetic_music` is hardcoded N/A always, never decided by the LLM -
these are silent flashcard illustrations with no story to score, so
there is no case in this pipeline where background music is the right
answer.

## Style: cartoon, same look as the image branch

`styles.py`'s `cartoon` `VideoStyle` reuses `imagegen.styles.STYLES["cartoon"].base_prompt`
and `.rendering_variants` directly - a word's video and its image(s)
should look like they belong to the same illustrated world. The genuinely
new axis is `motion_prompt`, written toward **low, simple, looping
motion** on purpose: this is a compressibility requirement as much as an
aesthetic one - h264 encodes a mostly-static frame with small, repeating
motion far smaller than one with busy or noisy motion, and these clips
need to be cheap to serve to every player on every replay. The
`review_rubric` tells a human reviewer to reject exactly that (camera
shake, jittery motion, a shifting background) alongside the same flat-
color/no-photorealism bar the image style already enforces.

## Model: Wan 2.2 TI2V-5B

Two Wan 2.2 checkpoints exist: **T2V-A14B** (14B MoE, two ~14.3GB fp8
expert transformers used at different denoising phases, ~28.6GB together)
and **TI2V-5B** (5B dense, single ~10GB transformer). This machine's
`../ComfyUI` install already had both cached from prior ComfyUI use, which
is what made a real side-by-side possible rather than a guess.

**TI2V-5B is what this pipeline uses**, via `Wan-AI/Wan2.2-TI2V-5B-Diffusers`
(the official Diffusers-format HF repo - `diffusers`' `WanPipeline` does
NOT load the cached ComfyUI-format single-file checkpoints directly; it
expects that repo's separate transformer/vae/text_encoder/tokenizer
layout, confirmed during this session's spike, so the first run downloads
its own ~20GB copy rather than reusing the ComfyUI cache). The MoE
T2V-A14B variant was ruled out for this machine: both experts together
(~28.6GB, fp8) do not fit a 24GB card alongside a VAE and text encoder
without CPU offload or expert-swapping support `diffusers` does not
document for Wan today.

Measured on this machine (2026-09-15 spike, a throwaway script run twice
against the same prompt/settings - not part of this package), 480x480,
121 frames (5s @ 24fps), 50 inference steps, bf16:

- Load time: ~25s
- VRAM after load: 22.81GB allocated
- Denoising: ~3.3 minutes (50 steps, ~4s/step) either way - tiling only
  affects the decode step below
- **Without** `pipe.vae.enable_tiling()`: peak **25.76GB allocated /
  27.03GB reserved** during VAE decode - over this card's real ~25.8GB
  (`24576 MiB`) capacity. It did not crash; Windows' WDDM driver silently
  spilled the overflow into slow shared system memory instead, and total
  generation time was **549.6s** (~9.2 min) as a result.
- **With** tiling enabled (`config.VAE_TILING`, on by default -
  `generate.py`'s `load_video_pipeline` calls it): peak **24.26GB
  allocated / 25.14GB reserved** - comfortably within the card - and total
  generation time dropped to **225.2s** (~3.75 min), more than 2x faster,
  purely from avoiding that spillover.

Conclusion: tiled VAE decode is not optional at this resolution/frame
count on a 24GB card - it is the difference between a clip that takes
under 4 minutes and one that takes over 9 minutes for identical output.
Re-measure before ever disabling `VAE_TILING`.

`DEFAULT_VARIANT_COUNT` in `config.py` is deliberately small (4, versus
imagegen's 8) given ~3.75 min/candidate above (a full batch for one word
at 4 variants is ~15 GPU-minutes) - revisit once a real overnight batch
has run and the actual words/night throughput this machine can sustain is
known.

## Resolution: 512x512, square

Matches the game's fixed 200x200 CSS box exactly (`public/vocab/style.css`'s
`.prompt-container`), the same reasoning `imagegen/config.py`'s resolution
comment documents for images - a scene composed for a square frame reads
better than a landscape composition cropped down to one by
`object-fit: cover`. `WanPipeline`'s own default is 480x832 (landscape);
square was chosen deliberately over that default for this reason, and
512 (not just "a multiple of 32 near 480", which is all the resolution
this file first shipped with actually verified) to match imagegen's own
512 exactly - 200 * 2.56, explicit retina headroom - rather than a
close-but-independently-reasoned number.

The VRAM/timing spike two sections up measured 480x480, before this
change - it has NOT been re-run at 512x512 (~14% more pixels). Re-measure
before trusting those exact numbers at the current default; see
`generate.py`'s `load_video_pipeline` for the same flag inline.

## Duration/FPS: 5s, 24fps -> 121 frames

Wan's frame-count convention is `4k+1` (matches the VAE's temporal
compression factor - confirmed against the downloaded
`Wan2.2-TI2V-5B-Diffusers` transformer/vae configs). `num_frames_for()` in
`generate.py` rounds `duration_seconds * fps` to the nearest valid count
rather than truncating.

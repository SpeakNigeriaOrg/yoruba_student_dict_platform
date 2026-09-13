# imagegen

Bulk, multi-style image generation and review for `word_images` (see
`db/migrations/0010_word_images.sql`). A plain Python CLI - no ComfyUI, no
node-based workflow UI - meant to run unattended: point it at the words
still missing an image in a given style, let it generate candidates
overnight, review the results in the morning.

Two steps, run separately on purpose (generation is GPU-bound and slow;
review is a human clicking through thumbnails - no reason to make one wait
on the other):

```sh
cd imagegen
uv sync
DATABASE_URL=postgres://... uv run python -m imagegen.generate --art-style cartoon --count 4
# ... later, once candidates/ has output ...
DATABASE_URL=postgres://... uv run python -m imagegen.review --art-style cartoon
```

`generate.py` queries `golden_record` for words with no `word_images` row
for `--art-style`, builds 4 (`--count`) prompt variants per word in that
style, and writes them to `candidates/{art_style}/{word_id}/v0.png`...
`v3.png` plus a `manifest.json` recording the exact prompt used for each -
nothing touches Postgres yet. Already-queued words are skipped on a re-run
(`--force` to redo), so it's safe to stop and restart an overnight run.

`review.py` starts a local web server (`http://localhost:4322`, loopback
only) showing one word's candidates at a time, along with that style's own
review rubric (see "Multiple styles" below) so you're judging each batch
against what "good" means for *that* style, not one generic bar. Click the
best one to accept it - this writes `word_images` (variant 1, the only
slot `exportGameContent.mjs`/`publishToR2.mjs` ever read) and deletes the
candidate directory. "Reject all" deletes the batch without writing
anything, so the word is missing an image again and the next `generate.py`
run picks it back up.

## Multiple styles

`word_images.art_style` is free text on purpose (see the migration's own
comment: "open-ended... more styles later without a migration"). `styles.py`
is the Python side of that: each `ArtStyle` entry carries its own prompt
base, its own set of rendering sub-variants (for intra-batch diversity -
see below), and its own review rubric. Adding a style is adding one entry
there - nothing else in the pipeline changes. Currently registered:

- **`cartoon`** (default) - flat vector clip-art, the original style, and
  the one this project's existing accepted images already use.
- **`collage`** - hand-painted, torn-tissue-paper collage with visible
  brushstroke texture and layered cut shapes. The prompt describes this
  *technique* deliberately, not a named illustrator or book title - the
  look itself (picture-book paper collage) isn't anyone's IP, but naming a
  specific still-in-copyright author/title in a generation prompt for a
  public-facing product would be inviting a style-imitation problem for no
  real benefit, so `styles.py`'s actual prompt text never does that.
- **`textile`** - the suggested third style: bold folk-art shapes filled
  with Adire/Aso-oke-inspired patterning and a warm earthy-plus-vibrant
  palette, rooted in this project's own (Yoruba/West African) cultural
  context rather than importing a second Western picture-book look.

Run `generate.py`/`review.py` once per style you want populated
(`--art-style collage`, etc.) - each style's candidates and `word_images`
rows are independent, so a word can end up with a cartoon image, a collage
image, or both.

## Model

**Z-Image-Turbo** (`Tongyi-MAI/Z-Image-Turbo`, Apache 2.0, 6B, 8-step
inference) via `diffusers`. Chosen over Krea 2 and Flux.2 Klein after a
September 2026 review of the current landscape:

- This project's `content/pending_images/` (the `z-image_00003_.png`-style
  backlog `migrateStagedImages.mjs`/`labelPendingImages.mjs` already know
  about) was generated with Z-Image before - staying on it keeps new
  output visually consistent with already-accepted images, at essentially
  zero license risk (Apache 2.0).
- Measured, not estimated: a real end-to-end smoke test on this machine
  (512x512, bf16, no quantization) peaked at **21.35GB/24GB VRAM**. That
  fits, but with real margin, not to spare - see the "two strict phases"
  note below on why the prompt-LLM step never runs concurrently with this.
- Krea 2 (released Jun 2026) is a genuinely newer/sharper 12B model, but
  needs its `fp8_scaled` checkpoint (~12.5GB) to fit a 24GB card at all -
  full bf16 needs 35GB+ - and ships under a custom community license.
  Worth a side-by-side pilot later; not the default.
- Flux.2 Klein's license-clean 4B variant (Apache 2.0) is meaningfully
  weaker output quality; the stronger 9B needs a non-commercial license
  that wants a deliberate read before use here.

`diffusers` currently has no PyPI release with the Z-Image pipeline
classes - `pyproject.toml` tracks the `diffusers` git `main` branch for
that reason. If Z-Image inference starts erroring after a routine
`uv sync -U`, that's the most likely cause; check whether upstream renamed
or moved the pipeline class.

## Resolution: 512x512

`games.speaknigeria.org/vocab` renders `#prompt-image` inside a
`.prompt-container` fixed at `200x200` CSS pixels
(`object-fit: cover`) - confirmed by fetching the live page's
`style.css`. Nothing in the publish pipeline
(`word_images` -> `exportGameContent.mjs` / `publishToR2.mjs`) resizes
images; whatever gets generated is served byte-identical. The current
`images/placeholder.png` is exactly `200x200` - no retina headroom at all.
512 gives ~2.56x headroom, comfortably covering 2x/3x-DPR displays.

## Prompt strategy: diversity *between* variants, not average quality

The point of this harness is **not** "make all 4 variants good" - `review.py`
keeps exactly one and throws the rest away, so nothing ever averages them.
What matters is maximizing the odds that *at least one* of the N lands,
even if that means the other three are mediocre or off-style. Every choice
below follows from that, and it's not only about who's depicted - it's
about composition, framing, and rendering approach too.

`prompts.py` builds each variant from a style template: clip-art base +
four independent slots sampled *without replacement* per word (composition,
framing, background, and a rendering **sub-style** - sticker-flat vs.
thin-line geometric vs. rounded storybook vs. bold poster, all still
clip-art but visually distinct approaches, so a concept that comes out weak
in one rendering can still land in another) plus a rotating, concrete
diversity clause for human subjects - deliberately a specific descriptor
("a Black West African person", "an East Asian person", ...) rather than a
vague "diverse" adjective, since the latter tends to get ignored or
rendered as a single collaged figure rather than actually varying who's
depicted across the batch.

By default, all N mechanical prompts for a word are then rewritten
*together in one call* by a local LLM - **Qwen3-8B**, already fully cached
locally (`~/.cache/huggingface/hub/models--Qwen--Qwen3-8B`, used by other
tooling on this machine already) and loaded directly via `transformers`,
no server, no new download. It's explicitly instructed to push the N
prompts further apart from each other, not smooth them into consistency -
seeing all N at once is what lets it do that; rewriting each in isolation
(the first version of this) couldn't. Research this session turned up real
evidence that an LLM rewrite pass measurably increases both visual and
demographic diversity of diffusion output versus a template alone (arXiv
2504.11104), while a pure template risks the "diversity collapse" templated
prompting is documented to cause (arXiv 2505.18949).

Any failure (parse mismatch, model error) falls back to the mechanical
prompts unchanged - an overnight batch must never crash or stall on the LLM
step. Pass `--no-llm` to skip this pass entirely.

**Never runs concurrently with image generation.** `generate.py` is a
strict two-phase pipeline: load Qwen3-8B, rewrite every queued word's
prompts, fully unload it (`del model; torch.cuda.empty_cache()`) - only
then does it load Z-Image. Qwen3-8B in bf16 is ~16GB on its own; Z-Image
alone already measured ~21.3GB peak (see above). Keeping both resident at
once would risk an OOM on a 24GB card for no benefit.

## Not built yet: text-to-video

Asked about separately - noting the answer here since it'll matter next
time this comes up. "MiniMax H3" (Hailuo 3.0, Jul 2026) is real and
open-weight, but it's 33B dense params (officially deployed across 4 GPUs)
and its community license **excludes local deployment in the US/EU/UK/
South Korea** - not usable here regardless of quantization.

**Wan 2.2** (`Wan-Video/Wan2.2`, Apache 2.0, 14B MoE) is the right target
to build against when this becomes the actual task: fits fp8-quantized on
a 24GB card with no CPU offload, has an official repo and diffusers
support, no ComfyUI needed. Re-verify VRAM numbers and license status
against a fresh search when that work actually starts - this space moves
in months, not years, and Wan has already shipped closed, API-only point
releases (2.5/2.6/2.7) since 2.2, so "2.2 is the latest open one" needs
reconfirming rather than assuming it still holds.

Also worth knowing before that work starts: this machine's `../ComfyUI`
install already has several Wan 2.2 checkpoints downloaded
(`models/diffusion_models/wan2.2_t2v_*_14B_fp8_scaled.safetensors`, plus
GGUF Q5 variants) from prior ComfyUI use - a plain-Python pipeline could
likely point straight at those cached weights instead of re-downloading,
the same way this tool ended up reusing the already-cached Z-Image and
Qwen3-8B weights instead of pulling something new.

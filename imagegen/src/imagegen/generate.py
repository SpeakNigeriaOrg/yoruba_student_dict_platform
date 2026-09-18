# Bulk, multi-style candidate generation.
#
# Usage:
#   DATABASE_URL=postgres://... python -m imagegen.generate --art-style cartoon [options]
#
# --art-style selects one of styles.STYLES (currently cartoon/collage/
# textile - see styles.py). word_images.art_style is free text precisely
# so new styles are additive: add one ArtStyle entry, no migration, no
# code change here.
#
# Two strict phases, run in this order and never overlapping in VRAM (the
# Z-Image-Turbo smoke test alone peaked at ~21.3GB/24GB at 512x512, so
# there is no headroom to keep an LLM resident alongside it):
#
#   1. Prompt phase: for every golden_record word with no word_images row
#      yet for --art-style, ask a local LLM (Qwen3-8B, already cached
#      locally) for --count DIFFERENT candidate scenes for the concept (not
#      one scene reused --count times - see prompts.py's module docstring
#      on why a shared scene hid real diversity failures: every "ball"
#      came out a soccer ball, every "father" came out the same "holding
#      hands" pose, across all 4 variants, because nothing ever asked for
#      a different referent or a different relational moment). Every word
#      gets scenes - there is no "not illustrable, skip it" exit (see
#      prompts.py's module docstring on why that option was removed
#      rather than tuned again). Each scene becomes one mechanical prompt
#      variant (prompts.py), then all of one word's variants are rewritten
#      together to push them further apart in phrasing/composition too -
#      see prompts.py's module docstring on why divergence between
#      variants, not average quality, is the goal here (review.py keeps
#      the single best and discards the rest). The LLM is fully unloaded
#      before phase 2 starts.
#   2. Image phase: load Z-Image-Turbo once, generate every surviving
#      word's variants, and write them to
#      candidates/{art_style}/{word_id}/v{n}.png plus a manifest.json
#      recording the exact prompt used for each. Nothing touches Postgres
#      here - that's review.py's job, once a human has picked a winner or
#      rejected the batch.
#
# Idempotent by default: a word_id that already has a candidates/ directory
# is skipped (still awaiting review), not regenerated - pass --force to
# redo it anyway (e.g. after tweaking the style prompt). --words always
# retries, even a word a past run skipped as not illustrable.
import argparse
import json
import time
from pathlib import Path

import torch

from . import config, db, prompts, styles

CANDIDATES_DIR = Path(__file__).resolve().parent.parent.parent / "candidates"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--art-style", default=config.DEFAULT_ART_STYLE,
        help=f"one of: {', '.join(sorted(styles.STYLES))} (see styles.py to add more)",
    )
    parser.add_argument("--count", type=int, default=config.DEFAULT_VARIANT_COUNT)
    parser.add_argument("--resolution", type=int, default=config.DEFAULT_RESOLUTION)
    parser.add_argument("--model", default=config.MODEL_ID)
    parser.add_argument(
        "--words", default=None,
        help="comma-separated word_ids to (re)generate instead of querying for words missing an image",
    )
    parser.add_argument("--limit", type=int, default=None, help="stop after this many words")
    parser.add_argument("--force", action="store_true", help="regenerate even if candidates already exist")
    parser.add_argument(
        "--no-llm", action="store_true",
        help="skip the local-LLM rewrite pass and use the mechanical template prompts as-is",
    )
    parser.add_argument("--llm-model", default=config.LLM_MODEL_ID)
    parser.add_argument("--seed-base", type=int, default=0)
    return parser.parse_args()


def load_image_pipeline(model_id: str):
    from diffusers import ZImagePipeline

    print(f"Loading {model_id}...")
    pipe = ZImagePipeline.from_pretrained(model_id, dtype=torch.bfloat16, low_cpu_mem_usage=False)
    pipe.to("cuda")
    return pipe


def effective_gloss(word: dict) -> str:
    """The gloss actually fed to the illustration pipeline. 18 of 185
    golden_record rows (as of this writing) have definition = NULL, but
    word_id itself encodes an English gloss as a readable suffix
    ("redio_radio" -> "radio", "fi_sile_leave_it" -> "leave it") -
    display_text's own word count tells us where the Yoruba part of
    word_id ends and the gloss begins. Without this, a NULL definition
    sends the LLM nothing but the bare Yoruba spelling to work from, and
    it can hallucinate freely - a real run did exactly that, turning
    "radio" (rédíò, no gloss) into a fruit, and "fi sílẹ̀" ("leave it",
    no gloss) into an unrelated bird/butterfly/spider nature scene. Falls
    back to display_text itself only if word_id doesn't parse into
    anything past the Yoruba part (shouldn't happen given the naming
    convention, but never worth crashing over)."""
    if word["definition"]:
        return word["definition"]
    segments = word["word_id"].split("_")
    yoruba_word_count = len(word["display_text"].split())
    gloss_segments = segments[yoruba_word_count:]
    return " ".join(gloss_segments) if gloss_segments else word["display_text"]


def generate_word_images(pipe, word, variant_prompts: list[str], args, candidates_root: Path):
    word_id = word["word_id"]
    out_dir = candidates_root / word_id
    out_dir.mkdir(parents=True, exist_ok=True)

    for i, prompt in enumerate(variant_prompts):
        generator = torch.Generator("cuda").manual_seed(args.seed_base + i)
        image = pipe(
            prompt=prompt,
            height=args.resolution,
            width=args.resolution,
            num_inference_steps=config.NUM_INFERENCE_STEPS,
            guidance_scale=config.GUIDANCE_SCALE,
            generator=generator,
        ).images[0]
        image.save(out_dir / f"v{i}.png")
        print(f"  {word_id}: variant {i + 1}/{len(variant_prompts)} done")

    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                "word_id": word_id,
                "art_style": args.art_style,
                "display_text": word["display_text"],
                "definition": word["definition"],
                "gloss_used": effective_gloss(word),
                "prompts": variant_prompts,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def main():
    args = parse_args()
    style = styles.get(args.art_style)
    candidates_root = CANDIDATES_DIR / args.art_style
    candidates_root.mkdir(parents=True, exist_ok=True)

    conn = db.connect()
    if args.words:
        word_ids = [w.strip() for w in args.words.split(",") if w.strip()]
        words = [db.word_by_id(conn, wid) for wid in word_ids]
        missing = [wid for wid, w in zip(word_ids, words) if w is None]
        if missing:
            raise SystemExit(f"Unknown word_id(s): {', '.join(missing)}")
        # --words deliberately bypasses "needs image" - that's its whole
        # point (test/redo any word, image or not) - but it has no idea
        # whether a target already has one, and review.py's overwrite
        # warning only fires once someone's reviewing, possibly long after
        # GPU time was already spent. A heads-up here costs nothing.
        already_have_one = [w["word_id"] for w in words if db.list_images(conn, w["word_id"], args.art_style)]
        if already_have_one:
            print(
                f'Note: {len(already_have_one)} of these already have at least one accepted "{args.art_style}" '
                f"image and will produce ADDITIONAL candidates, not replacements: {', '.join(already_have_one)}"
            )
    else:
        words = db.words_needing_image(conn, args.art_style)
    conn.close()

    if not args.force:
        words = [w for w in words if not (candidates_root / w["word_id"]).exists()]
    if args.limit:
        words = words[: args.limit]
    if not words:
        print(f'No words need a "{args.art_style}" image (or none matched --words / all already have pending candidates).')
        return

    print(f"{len(words)} word(s) queued for generation, {args.count} variant(s) each.")

    # Phase 1: for each word, decide what to draw, then build --count
    # structurally-different prompts for it - see module docstring for why
    # this must fully finish, and the LLM be fully unloaded, before phase 2
    # touches the GPU at all. Every word gets prompts - there's no "not
    # illustrable" exit anymore (see prompts.py's module docstring on why
    # that was removed rather than tuned again).
    if args.no_llm:
        # No illustration_scenes and no rewrite step - the mechanical
        # scene IS the final content, so the human-clause decision can
        # (and must) happen directly on it. Weaker than the LLM path on
        # verbs/phrases/relational nouns/generic categories (see module
        # docstring) - the trade this mode makes for having no model
        # dependency at all.
        word_prompts = {
            w["word_id"]: prompts.build_variant_prompts(style, [effective_gloss(w)] * args.count, args.count)
            for w in words
        }
    else:
        rewriter = prompts.LocalLLMRewriter(args.llm_model)
        try:
            word_scenes = {}
            for w in words:
                scenes = rewriter.illustration_scenes(effective_gloss(w), w["display_text"], args.count)
                word_scenes[w["word_id"]] = prompts.build_variant_scenes(scenes, args.count)

            # Rewrite the scene (content only - never style text, see
            # module docstring "Round 7"), decide the human clause from
            # THAT, then apply style last - see docstring ("Round 5") on
            # why the human-clause decision runs on the rewritten content
            # rather than the pre-rewrite concept: deciding before
            # rewriting and just carrying the clause through unchanged
            # went stale in practice ("a box with earphones" -> rewritten
            # into "a person listening to a box with earphones", a person
            # the pre-rewrite decision never saw).
            word_prompts = {}
            for word_id, scenes in word_scenes.items():
                rewritten_scenes = rewriter.rewrite_batch(style, scenes)
                styled = prompts.apply_style(style, rewritten_scenes, args.count)
                pairs = prompts.attach_human_clauses(rewritten_scenes)
                word_prompts[word_id] = [
                    prompts.compose(styled[i], pairs[i][1]) for i in range(args.count)
                ]
        finally:
            rewriter.unload()

    # Phase 2: image generation.
    pipe = load_image_pipeline(args.model)
    for word in words:
        generate_word_images(pipe, word, word_prompts[word["word_id"]], args, candidates_root)

    print(f"\nDone. Review with: python -m imagegen.review --art-style {args.art_style}")


if __name__ == "__main__":
    main()

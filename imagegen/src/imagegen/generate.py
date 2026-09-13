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
#      yet for --art-style, build --count mechanical prompt variants
#      (prompts.py), then optionally rewrite all of one word's variants
#      together via a local LLM (Qwen3-8B, already cached locally) to push
#      them further apart from each other - see prompts.py's module
#      docstring on why divergence between variants, not average quality,
#      is the goal here (review.py keeps the single best and discards the
#      rest). The LLM is fully unloaded before phase 2 starts.
#   2. Image phase: load Z-Image-Turbo once, generate every word's
#      variants, and write them to
#      candidates/{art_style}/{word_id}/v{n}.png plus a manifest.json
#      recording the exact prompt used for each. Nothing touches Postgres
#      here - that's review.py's job, once a human has picked a winner or
#      rejected the batch.
#
# Idempotent by default: a word_id that already has a candidates/ directory
# is skipped (still awaiting review), not regenerated - pass --force to
# redo it anyway (e.g. after tweaking the style prompt).
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
                "prompts": variant_prompts,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
        )
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

    # Phase 1: prompts (mechanical, then optionally LLM-diverged) - see
    # module docstring for why this must fully finish, and the LLM be fully
    # unloaded, before phase 2 touches the GPU at all.
    #
    # The LLM only ever sees the visual half of each draft, never the human
    # -diversity clause (prompts.py's module docstring explains why: an
    # earlier version let the LLM rewrite the whole sentence and it turned
    # a conditional "if this depicts a person" hedge into a flat assertion,
    # putting a person's portrait onto a plate/bowl image). The clause -
    # verbatim, untouched - gets recombined with the rewritten visual below.
    word_drafts = {
        w["word_id"]: prompts.build_variant_drafts(style, w["definition"], w["display_text"], args.count)
        for w in words
    }
    if not args.no_llm:
        rewriter = prompts.LocalLLMRewriter(args.llm_model)
        try:
            for word_id, draft_pairs in word_drafts.items():
                visuals = [visual for visual, _clause in draft_pairs]
                clauses = [clause for _visual, clause in draft_pairs]
                rewritten_visuals = rewriter.rewrite_batch(style, visuals)
                word_drafts[word_id] = list(zip(rewritten_visuals, clauses))
        finally:
            rewriter.unload()

    word_prompts = {
        word_id: [prompts.compose(visual, clause) for visual, clause in draft_pairs]
        for word_id, draft_pairs in word_drafts.items()
    }

    # Phase 2: image generation.
    pipe = load_image_pipeline(args.model)
    for word in words:
        generate_word_images(pipe, word, word_prompts[word["word_id"]], args, candidates_root)

    print(f"\nDone. Review with: python -m imagegen.review --art-style {args.art_style}")


if __name__ == "__main__":
    main()

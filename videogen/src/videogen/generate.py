# Bulk, multi-style candidate generation - the videogen sibling of
# imagegen/generate.py, structured the same way on purpose.
#
# Usage:
#   DATABASE_URL=postgres://... python -m videogen.generate --video-style cartoon [options]
#
# Same two-strict-phases discipline as imagegen/generate.py, for the same
# reason: Qwen3-8B (bf16, ~16GB) must be fully unloaded before MiniMax-H3's
# transformer + Qwen3-VL conditioner load, or the two together risk an OOM
# on this machine's 24GB card - MiniMax-H3 already needs int8 quantization
# and block-level CPU offload just on its own to fit (see config.py/
# load_video_pipeline). The LLM phase here is IDENTICAL to imagegen's for
# the still-frame decision (same LocalLLMRewriter, same scene-generation
# logic, reused not duplicated - see prompts.py) plus this package's own
# motion_directions step - only the render phase differs (video, not a
# single image, and far more expensive per candidate: DEFAULT_VARIANT_COUNT
# is small on purpose, see config.py).
#
# Model choice (MiniMax-H3, int8 + block offload, guidance-distilled - no
# negative_prompt/guidance_scale anywhere in this file) is the result of a
# real side-by-side against Wan 2.2 and LTX-2.5 Distilled - see config.py's
# MODEL_ID comment for the actual verdict and where the comparison lives.
#
# Idempotent by default, same as imagegen/generate.py: a word_id that
# already has a candidates/ directory is skipped, not regenerated, unless
# --force.
import argparse
import json
import math
import time
from pathlib import Path

import torch
from imagegen.generate import effective_gloss  # generic golden_record-shape helper, not image-specific

from . import config, db, prompts, styles

CANDIDATES_DIR = Path(__file__).resolve().parent.parent.parent / "candidates"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--video-style", default=config.DEFAULT_VIDEO_STYLE,
        help=f"one of: {', '.join(sorted(styles.STYLES))} (see styles.py to add more)",
    )
    parser.add_argument("--count", type=int, default=config.DEFAULT_VARIANT_COUNT)
    parser.add_argument("--width", type=int, default=config.DEFAULT_WIDTH)
    parser.add_argument("--height", type=int, default=config.DEFAULT_HEIGHT)
    parser.add_argument("--duration-seconds", type=float, default=config.DEFAULT_DURATION_SECONDS)
    parser.add_argument("--fps", type=int, default=config.FPS)
    parser.add_argument("--model", default=config.MODEL_ID)
    parser.add_argument(
        "--words", default=None,
        help="comma-separated word_ids to (re)generate instead of querying for words missing a video",
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


def num_frames_for(duration_seconds: float, fps: int) -> int:
    """MiniMax-H3's frame-count convention: num_frames snaps UP to the
    next `17*n + 5` its video VAE can decode (confirmed against this
    session's real generations - unrelated to Wan's old `4k+1`, which
    this function replaced). Generation constraints require the
    resulting duration stay in [5, 15] seconds - 5s is the shortest,
    cheapest valid choice, which is why config.py defaults to it."""
    n = math.ceil((duration_seconds * fps - 5) / 17)
    return max(5, 17 * n + 5)


def load_video_pipeline(model_id: str):
    from diffusers import MiniMaxH3Transformer3DModel, ModularPipeline, TorchAoConfig
    from diffusers.hooks import apply_group_offloading
    from torchao.quantization import Int8WeightOnlyConfig
    from transformers import Qwen3VLForConditionalGeneration
    from transformers import TorchAoConfig as TransformersTorchAoConfig

    print(f"Loading {model_id} (int8 weight-only + block-level CPU offload)...")
    pipe = ModularPipeline.from_pretrained(model_id, cache_dir=config.CACHE_DIR)
    pipe.update_components(
        transformer=MiniMaxH3Transformer3DModel.from_pretrained(
            model_id, subfolder="transformer", dtype=torch.bfloat16, cache_dir=config.CACHE_DIR,
            quantization_config=TorchAoConfig(
                Int8WeightOnlyConfig(version=2),
                modules_to_not_convert=[
                    "proj_in", "audio_proj_in", "context_embedder", "time_embedder", "time_proj",
                    "token_refiner", "norm_out", "proj_out", "audio_proj_out",
                ],
            ),
        ),
        text_encoder=Qwen3VLForConditionalGeneration.from_pretrained(
            model_id, subfolder="text_encoder", dtype=torch.bfloat16, cache_dir=config.CACHE_DIR,
            quantization_config=TransformersTorchAoConfig(
                Int8WeightOnlyConfig(version=2),
                modules_to_not_convert=[
                    "model.visual", "model.language_model.embed_tokens", "model.language_model.norm", "lm_head",
                ],
            ),
        ),
    )
    pipe.load_components(workflow="t2va", dtype=torch.bfloat16, cache_dir=config.CACHE_DIR)
    # t2va's own default component set omits `processor` (it's only wired
    # for image/video-reference workflows in the library's own listing),
    # but the shared Qwen3-VL encoder path unconditionally calls
    # processor.create_mm_token_type_ids(...) regardless of workflow, so a
    # text-only request still needs it loaded explicitly or that call
    # hits it as None - a real bug hit and fixed this session. Root cause
    # was actually one layer deeper: Qwen3VLProcessor itself needs
    # torchvision, which this venv never had, and the pipeline's own
    # loader silently swallowed that ImportError rather than raising -
    # `uv pip install torchvision` (matching the installed torch's CUDA
    # build) is the real fix; loading `processor` explicitly here just
    # surfaces the failure instead of leaving it as a mysterious None.
    pipe.load_components(names="processor", dtype=torch.bfloat16, cache_dir=config.CACHE_DIR)
    pipe.transformer.requires_grad_(False)
    pipe.text_encoder.requires_grad_(False)

    offload = dict(onload_device=torch.device("cuda"), offload_device=torch.device("cpu"), use_stream=True)
    pipe.transformer.enable_group_offload(offload_type="block_level", num_blocks_per_group=1, **offload)
    apply_group_offloading(pipe.text_encoder.model, offload_type="leaf_level", **offload)
    pipe.vae.to("cuda")
    pipe.audio_vae.to("cuda")
    return pipe


def generate_word_videos(pipe, word, variant_prompts: list[str], args, candidates_root: Path):
    from .encode import encode_video  # tested CRF/tune/audio-bitrate policy - see that module

    word_id = word["word_id"]
    out_dir = candidates_root / word_id
    out_dir.mkdir(parents=True, exist_ok=True)
    num_frames = num_frames_for(args.duration_seconds, args.fps)

    for i, prompt in enumerate(variant_prompts):
        # No CUDA generator here (unlike Wan) - MiniMax-H3's own examples
        # use a plain CPU torch.Generator; the model's guidance-distilled
        # checkpoint has no negative_prompt/guidance_scale to pass either
        # (see config.py).
        generator = torch.Generator().manual_seed(args.seed_base + i)
        results = pipe(
            prompt=prompt,
            height=args.height,
            width=args.width,
            num_frames=num_frames,
            generator=generator,
            output=["videos", "audio", "sampling_rate"],
        )
        # MiniMax-H3 denoises video and audio jointly in one packed
        # sequence, so the audio comes "free" alongside the video either
        # way - kept and muxed in rather than discarded. An earlier
        # version of this code dropped it, reasoning the game only ever
        # plays these muted - but the video branch of the game has never
        # actually been deployed, so there was no real basis for treating
        # "always muted" as settled and throwing away data on that
        # assumption.
        encode_video(
            results["videos"][0], fps=args.fps, output_path=str(out_dir / f"v{i}.mp4"),
            audio=results["audio"][0], audio_sample_rate=results["sampling_rate"],
        )
        print(f"  {word_id}: variant {i + 1}/{len(variant_prompts)} done")

    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                "word_id": word_id,
                "video_style": args.video_style,
                "display_text": word["display_text"],
                "definition": word["definition"],
                "gloss_used": effective_gloss(word),
                "prompts": variant_prompts,
                "width": args.width,
                "height": args.height,
                "fps": args.fps,
                "num_frames": num_frames,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def main():
    args = parse_args()
    style = styles.get(args.video_style)
    candidates_root = CANDIDATES_DIR / args.video_style
    candidates_root.mkdir(parents=True, exist_ok=True)

    conn = db.connect()
    if args.words:
        word_ids = [w.strip() for w in args.words.split(",") if w.strip()]
        words = [db.word_by_id(conn, wid) for wid in word_ids]
        missing = [wid for wid, w in zip(word_ids, words) if w is None]
        if missing:
            raise SystemExit(f"Unknown word_id(s): {', '.join(missing)}")
        already_have_one = [w["word_id"] for w in words if db.list_videos(conn, w["word_id"], args.video_style)]
        if already_have_one:
            print(
                f'Note: {len(already_have_one)} of these already have at least one accepted "{args.video_style}" '
                f"video and will produce ADDITIONAL candidates, not replacements: {', '.join(already_have_one)}"
            )
    else:
        words = db.words_needing_video(conn, args.video_style)
    conn.close()

    if not args.force:
        words = [w for w in words if not (candidates_root / w["word_id"]).exists()]
    if args.limit:
        words = words[: args.limit]
    if not words:
        print(f'No words need a "{args.video_style}" video (or none matched --words / all already have pending candidates).')
        return

    print(f"{len(words)} word(s) queued for generation, {args.count} variant(s) each.")

    # Phase 1: identical shape to imagegen/generate.py's for the still-
    # frame decision - see that module's docstring for the full reasoning
    # (every word gets scenes, no "not illustrable" exit; rewrite touches
    # scene CONTENT only, never style text - "Round 7"; the human-clause
    # decision runs on the rewritten content, before style is applied -
    # "Round 5"/"Round 6"). Motion+sound direction is video's own added
    # step (prompts.motion_and_sound_directions) - it runs last, on the
    # fully-finished still-frame text (content + style + human clause),
    # for the same reason attach_human_clauses runs right after
    # rewrite_batch: deciding it from an earlier draft risks the decision
    # going stale once a later step changes what's actually in frame.
    # compose_minimax_prompt then wraps everything into the model's own
    # documented three-field format - see prompts.py's "Round 8".
    if args.no_llm:
        word_scenes = {
            w["word_id"]: prompts.build_variant_scenes([effective_gloss(w)] * args.count, args.count)
            for w in words
        }
        # No LLM resident in this mode, so motion+sound fall back to the
        # style's ambient defaults for every scene - see --no-llm's own
        # tradeoffs in imagegen/generate.py's docstring; the same
        # "weaker but no model dependency" trade applies here.
        word_prompts = {}
        for word_id, scenes in word_scenes.items():
            styled = prompts.apply_style(style, scenes, args.count)
            pairs = prompts.attach_human_clauses(scenes)
            word_prompts[word_id] = [
                prompts.compose_minimax_prompt(
                    prompts.compose(styled[i], pairs[i][1]), style.motion_prompt, style.soundscape_prompt,
                )
                for i in range(args.count)
            ]
    else:
        rewriter = prompts.LocalLLMRewriter(args.llm_model)
        try:
            word_scenes = {}
            for w in words:
                scenes = rewriter.illustration_scenes(effective_gloss(w), w["display_text"], args.count)
                word_scenes[w["word_id"]] = prompts.build_variant_scenes(scenes, args.count)

            word_prompts = {}
            for w in words:
                word_id = w["word_id"]
                rewritten_scenes = rewriter.rewrite_batch(style, word_scenes[word_id])
                styled = prompts.apply_style(style, rewritten_scenes, args.count)
                pairs = prompts.attach_human_clauses(rewritten_scenes)
                still_frames = [prompts.compose(styled[i], pairs[i][1]) for i in range(args.count)]
                motion_sound = prompts.motion_and_sound_directions(
                    rewriter, effective_gloss(w), w["display_text"], still_frames, style,
                )
                word_prompts[word_id] = [
                    prompts.compose_minimax_prompt(still, motion, sound)
                    for still, (motion, sound) in zip(still_frames, motion_sound)
                ]
        finally:
            rewriter.unload()

    # Phase 2: video generation.
    pipe = load_video_pipeline(args.model)
    for word in words:
        generate_word_videos(pipe, word, word_prompts[word["word_id"]], args, candidates_root)

    print(f"\nDone. Review with: python -m videogen.review --video-style {args.video_style}")


if __name__ == "__main__":
    main()

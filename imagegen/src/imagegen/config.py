# Defaults shared by generate.py and review.py. Resolution: the vocab game
# (games.speaknigeria.org/vocab) displays #prompt-image at a fixed 200x200 CSS
# box with object-fit: cover, and nothing in the publish pipeline
# (word_images -> exportGameContent.mjs / publishToR2.mjs) resizes images -
# whatever we generate is served byte-for-byte. 512 gives ~2.56x headroom,
# comfortably covering 2x/3x retina displays without upscaling artifacts.
DEFAULT_RESOLUTION = 512
# Bigger than it sounds like it needs to be, on purpose: this pipeline's
# whole design is "maximize the odds one of N is a hit, not the average of
# N" (see prompts.py's module docstring) - more candidates per word raises
# that odds directly, and generation is cheap (~3s/image) relative to a
# human reviewing once and being done with a word for good.
DEFAULT_VARIANT_COUNT = 8
DEFAULT_ART_STYLE = "cartoon"

# Turbo trades a small quality gap for 8-step inference (vs. ~28+ for the
# base model) - the right trade for an unattended overnight batch job. Swap
# to "Tongyi-MAI/Z-Image" (and raise steps/guidance accordingly) if a later
# side-by-side comparison decides the quality gap matters more than speed.
MODEL_ID = "Tongyi-MAI/Z-Image-Turbo"
NUM_INFERENCE_STEPS = 9  # 8 DiT forwards, per the model card
GUIDANCE_SCALE = 0.0  # required for the Turbo checkpoint - CFG is baked in

# Already fully cached locally (~/.cache/huggingface/hub/models--Qwen--Qwen3-8B,
# used by other local tooling) - loaded directly via transformers, no server,
# no new download. See prompts.LocalLLMRewriter for why it's loaded/unloaded
# as its own phase rather than kept resident alongside the image pipeline.
LLM_MODEL_ID = "Qwen/Qwen3-8B"
LLM_MAX_NEW_TOKENS_PER_VARIANT = 100

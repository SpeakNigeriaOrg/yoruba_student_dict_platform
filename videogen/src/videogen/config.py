# Defaults shared by generate.py and review.py - the videogen sibling of
# imagegen/config.py. Every number here was picked from a real measurement
# taken on this machine, not copied from imagegen's image defaults - video
# generation is a different cost/VRAM shape entirely, so nothing here
# should be assumed to transfer from the image pipeline's numbers.
#
# Model choice: a real side-by-side (2026-09-15/16 session) compared Wan
# 2.2 TI2V-5B, MiniMax H3, and LTX-2.5 Distilled on the same three prompts
# of increasing motion complexity. Wan repeatedly produced real corruption
# (duplicated/smeared objects with color-fringed edges) at least once per
# clip - not a one-off, a recurring failure at both its standard and Turbo
# settings. MiniMax H3 was the clear quality winner: zero corruption
# across every clip and every sampled frame, the correct flat-cartoon
# style, and the best motion fidelity of the three. LTX-2.5 Distilled was
# a close, much faster second (see videogen/README.md's superseded "Model"
# section history and imagegen/bench.py / imagegen/minimax_bench.py /
# LTX-2's own CLI for the actual comparison scripts) - kept as a documented
# fast fallback, not wired into this package.
MODEL_ID = "MiniMaxAI/MiniMax-H3"

# MiniMax-H3 ships as a ModularPipeline with two checkpoint partitions
# (t2va/fl2va share `transformer/`; `ref2va` uses a separate
# `transformer_ref/`, ~66GB on its own) plus a ~62GB Qwen3-VL conditioner -
# this package only ever uses the `t2va` (text-only) workflow, so
# `transformer_ref/` and the `FL2VA/`/`Ref2VA/` bulk-checkpoint folders
# (144GB EACH - a real mistake made once this session, downloading ~230GB
# that was never needed before the `allow_patterns` fix below) must stay
# excluded. See db.py/generate.py's download call for the exact
# `allow_patterns` this depends on.
CACHE_DIR = "D:/Dev/hf-video-models"

# Square, matching the game's fixed 200x200 CSS box exactly (same
# reasoning as imagegen/config.py's DEFAULT_RESOLUTION comment) rather
# than generating landscape and relying on object-fit: cover to crop it -
# a generated scene composed for a square frame reads better than a
# landscape composition cropped down to one. 512 (not just "a multiple of
# 32", which MiniMax-H3 requires and 512 satisfies) to match imagegen's
# own 512 exactly - 200 * 2.56, explicit retina headroom.
DEFAULT_WIDTH = 512
DEFAULT_HEIGHT = 512

DEFAULT_DURATION_SECONDS = 5
# MiniMax-H3's native frame rate. num_frames is snapped up to the next
# `17*n + 5` the video VAE can decode (its own convention, unrelated to
# Wan's `4k+1`) - see num_frames_for below. Generation constraints require
# staying in [5, 15] seconds; 5s is the shortest and cheapest valid choice.
FPS = 24

# Diversity-over-average-quality, same philosophy as imagegen's
# DEFAULT_VARIANT_COUNT - but unlike images (~3s/candidate, so 8 is
# nearly free), MiniMax-H3 measured ~490s/candidate on this machine
# (int8 + block-level CPU offload, needed to fit a 24GB card - see
# db.py/generate.py). 4 variants/word is already ~33 GPU-minutes/word
# before generation even starts reusing the loaded model for the next
# word - a real production run's actual words/night throughput should be
# measured before ever raising this.
DEFAULT_VARIANT_COUNT = 4
DEFAULT_VIDEO_STYLE = "cartoon"

# MiniMax-H3's checkpoints are guidance-distilled: guidance is baked into
# the weights, so there is no guider, no negative_prompt, and no
# guidance_scale anywhere in this package (unlike Wan, which needed both -
# and got the first real spike's output wrong by omitting the negative
# prompt the model card pairs with its guidance_scale). One request is
# exactly one forward pass per denoising step.

# Already cached locally (~/.cache/huggingface/hub/models--Qwen--Qwen3-8B,
# shared with imagegen) - see prompts.py for why this package reuses
# imagegen's LocalLLMRewriter rather than duplicating it. Not to be
# confused with MiniMax-H3's OWN conditioner (Qwen3-VL, a much larger,
# separate model this package loads directly from MODEL_ID's own
# `text_encoder/` subfolder) - this is only for the scene/motion prompt-
# writing LLM step, never resident at the same time as the video model.
LLM_MODEL_ID = "Qwen/Qwen3-8B"

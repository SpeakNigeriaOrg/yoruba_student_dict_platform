# Prompt construction for bulk multi-style generation.
#
# The goal here is NOT "make every one of the N variants good" - it's
# "maximize the odds at least one of the N is a hit". review.py's job is
# picking the single best of N and discarding the rest; nothing ever
# averages them. That means diversity *between* the N variants in one
# word's batch is the thing worth optimizing for, even at the cost of a
# variant or two coming out mediocre or off-style - a batch of 4 near-
# identical good prompts is worse for this pipeline than a batch of 4
# genuinely different attempts, one of which lands. This shows up in two
# places below: the slot lists sample four independent axes (composition,
# framing, background, AND the style's own rendering sub-variants - see
# styles.py) so no two variants in a batch share the same combination, and
# the optional LLM pass rewrites all N prompts for a word together in one
# call instructed to push them apart from each other, not to smooth them
# into consistency.
#
# What "a hit" means is itself style-relative (a photorealistic-shaded
# candidate is a miss for "cartoon" and irrelevant for "collage", which
# wants visible paper texture instead) - build_variant_prompts and
# LocalLLMRewriter both take an ArtStyle (styles.py) rather than assuming
# one hardcoded look, so adding a style is adding one styles.py entry, not
# touching this module.
#
# Two layers (research behind this: templated prompting alone tends to
# under-diversify a batch, while an LLM rewrite pass measurably increases
# both visual and demographic diversity of output - see README.md sources):
#
#   1. A mechanical template (this module, no model calls) builds N
#      structurally-different prompts per word by sampling slots WITHOUT
#      replacement. This alone is enough to produce usable output and is
#      the fallback if step 2 is skipped or fails.
#   2. An optional local-LLM rewrite pass (LocalLLMRewriter.rewrite_batch)
#      asks Qwen3-8B - already cached locally for other tooling, no new
#      download - to rephrase the N mechanical prompts for a word as one
#      natural-reading set, explicitly told to diverge them further rather
#      than converge them. Any failure (parse mismatch, model error) falls
#      back to the mechanical prompts unchanged - an unattended overnight
#      batch must never crash or stall on the LLM step.
import random
import re

from . import config
from .styles import ArtStyle

# Deliberately concrete descriptors, not a vague "diverse" adjective - a
# model asked for "a diverse person" tends to either ignore the word or
# render a token multi-ethnic collage in one figure. Naming one concrete
# descriptor per variant and rotating the set across a word's batch is what
# actually produces a mixed set of people over N variants instead of a
# default-white subject every time. Shared across every style - who gets
# depicted is orthogonal to the rendering aesthetic.
WHITE_EUROPEAN_DESCRIPTOR = "a white European person"
HUMAN_DESCRIPTORS = [
    "a Black West African person",
    "a South Asian person",
    "an East Asian person",
    WHITE_EUROPEAN_DESCRIPTOR,
    "a Latino or Hispanic person",
    "a Middle Eastern person",
]

COMPOSITIONS = [
    "a three-quarter view",
    "a front-facing view",
    "a dynamic action pose",
    "a simple centered pose",
]
BACKGROUNDS = [
    "a plain white background",
    "a softly colored solid pastel background",
    "a plain light-gray background",
    "a minimal background with only a few simple shapes suggesting the setting",
]
FRAMINGS = [
    "close-up composition",
    "medium shot showing the full subject",
    "wide framing with a little surrounding context",
]


def _sample_without_replacement(options: list[str], count: int) -> list[str]:
    """count may exceed len(options) (e.g. 4 variants, 3 framings) - cycle
    extra picks from a fresh shuffled pass rather than repeating the same
    option back-to-back."""
    picks: list[str] = []
    while len(picks) < count:
        picks.extend(random.sample(options, len(options)))
    return picks[:count]


def build_variant_prompts(style: ArtStyle, definition: str, display_text: str, count: int) -> list[str]:
    concept = definition or display_text
    compositions = _sample_without_replacement(COMPOSITIONS, count)
    backgrounds = _sample_without_replacement(BACKGROUNDS, count)
    framings = _sample_without_replacement(FRAMINGS, count)
    rendering_variants = _sample_without_replacement(style.rendering_variants, count)
    descriptors = _sample_without_replacement(HUMAN_DESCRIPTORS, count)

    prompts = []
    for i in range(count):
        # The "rather than defaulting to..." framing only makes sense for a
        # descriptor other than the one it's contrasting against - attaching
        # it unconditionally would produce a self-contradictory sentence on
        # the ~1-in-6 draws that land on "a white European person".
        if descriptors[i] == WHITE_EUROPEAN_DESCRIPTOR:
            diversity_clause = f"If the illustration depicts a human being, depict {descriptors[i]}."
        else:
            diversity_clause = (
                f"If the illustration depicts a human being, depict {descriptors[i]} "
                f"rather than defaulting to a white Western appearance."
            )
        prompts.append(
            f"{concept}, {compositions[i]}, {framings[i]}, {backgrounds[i]}, "
            f"{style.base_prompt}, {rendering_variants[i]}. {diversity_clause}"
        )
    return prompts


_NUMBERED_LINE = re.compile(r"^\s*(\d+)[.):]\s*(.+)$")


class LocalLLMRewriter:
    """Loads Qwen3-8B (already cached locally: ~/.cache/huggingface/hub/
    models--Qwen--Qwen3-8B) directly via transformers - no server, no new
    download. Deliberately NOT kept resident alongside the image pipeline:
    the Z-Image smoke test peaked at ~21.3GB/24GB on its own, so this class
    is meant to be used, then unload()ed, before ZImagePipeline loads."""

    def __init__(self, model_id: str = config.LLM_MODEL_ID):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        print(f"Loading local LLM {model_id} for prompt rewriting...")
        self._torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.bfloat16).to("cuda")
        self.model.eval()

    def rewrite_batch(self, style: ArtStyle, variant_prompts: list[str]) -> list[str]:
        """Rewrites all of one word's variants together (one call, not N)
        so the model can see the full set and is explicitly told to push
        them apart - see module docstring on why divergence, not average
        quality, is the target. The style's own review_rubric is passed in
        so the model diverges prompts along axes that actually matter for
        THIS style, not generic ones. Falls back to the mechanical prompts
        unchanged if the model errors or its reply doesn't parse back into
        exactly len(variant_prompts) lines."""
        n = len(variant_prompts)
        numbered_drafts = "\n".join(f"{i + 1}. {p}" for i, p in enumerate(variant_prompts))
        messages = [
            {
                "role": "system",
                "content": (
                    f'You write prompts for a text-to-image model, in a style called '
                    f'"{style.label}". You are given {n} draft prompts, each a variation '
                    "of the same illustration concept in that style. Rewrite each into one "
                    "natural, well-formed sentence, keeping its meaning, style description, "
                    "and any diversity instruction it contains intact. Only the single "
                    f"best-looking image of the {n} will be kept and the rest thrown away, "
                    f"so make the {n} rewritten prompts as different from each other as you "
                    "can in pose, composition, and visual interpretation of the concept - "
                    "favor bold variation between them over keeping them similar. "
                    f"What counts as a good result in this style: {style.review_rubric} "
                    f"Reply with exactly {n} lines, each starting with its number and a "
                    "period, nothing else - no preamble, no blank lines, no commentary."
                ),
            },
            {"role": "user", "content": numbered_drafts},
        ]
        try:
            text = self.tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
            )
            inputs = self.tokenizer(text, return_tensors="pt").to(self.model.device)
            with self._torch.no_grad():
                output_ids = self.model.generate(
                    **inputs,
                    max_new_tokens=config.LLM_MAX_NEW_TOKENS_PER_VARIANT * n,
                    do_sample=True,
                    temperature=0.9,
                )
            new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
            reply = self.tokenizer.decode(new_tokens, skip_special_tokens=True)
            # Qwen3 can emit a <think>...</think> block even with
            # enable_thinking=False on some snapshots - only the part after
            # it (if any) is the actual reply.
            reply = reply.rsplit("</think>", 1)[-1]

            rewritten = {}
            for line in reply.splitlines():
                m = _NUMBERED_LINE.match(line)
                if m:
                    rewritten[int(m.group(1))] = m.group(2).strip().strip('"')

            if set(rewritten) != set(range(1, n + 1)):
                print(f"  (LLM rewrite skipped: expected {n} numbered lines, parsed {len(rewritten)})")
                return variant_prompts
            return [rewritten[i] for i in range(1, n + 1)]
        except Exception as exc:  # noqa: BLE001 - any failure just falls back
            print(f"  (LLM rewrite skipped: {exc})")
            return variant_prompts

    def unload(self):
        del self.model
        self._torch.cuda.empty_cache()

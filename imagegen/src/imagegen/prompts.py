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
#
# The human-diversity clause is kept structurally separate from both of
# those (build_variant_drafts returns (visual, clause) pairs, and the LLM
# rewrite in generate.py only ever sees `visual`) after a real-DB smoke
# test caught it going badly wrong: "abo" (plate/bowl) came back with a
# person's portrait painted where the plate should have been, in multiple
# styles. Two compounding causes, both fixed here:
#   - the clause was a conditional sentence ("if the illustration depicts
#     a human being, depict X") glued onto every prompt regardless of
#     concept. Text-to-image models don't reliably honor "if" conditions -
#     mentioning "a person" at all tends to make one appear - and the LLM
#     rewrite pass made it worse by flattening the conditional into a flat
#     "featuring a Latino person" assertion.
#   - COMPOSITIONS included "a dynamic action pose", which itself implies
#     a body, applied to a definition that was just an inanimate object.
# The fix: decide ONCE per word (_mentions_person, a keyword heuristic
# over the definition/gloss) whether the concept plausibly involves a
# depicted human being at all. If not, no human-descriptor text is ever
# generated for that word, in any variant - not even conditionally. If so,
# the descriptor is a direct instruction ("depict a Black West African
# person"), not a hedge, since we've already decided a person belongs in
# frame. The heuristic is deliberately biased toward *missing* real human
# concepts (losing a diversity opportunity) over *falsely* tagging an
# object as human (which is what actually broke output).
import random
import re

from . import config
from .styles import ArtStyle

WHITE_EUROPEAN_DESCRIPTOR = "a white European person"
HUMAN_DESCRIPTORS = [
    "a Black West African person",
    "a South Asian person",
    "an East Asian person",
    WHITE_EUROPEAN_DESCRIPTOR,
    "a Latino or Hispanic person",
    "a Middle Eastern person",
]

_PERSON_WORDS = [
    "person", "people", "human", "somebody", "someone", "anybody",
    "man", "woman", "boy", "girl", "child", "children", "kid", "baby", "infant",
    "father", "mother", "parent", "brother", "sister", "sibling",
    "son", "daughter", "husband", "wife", "bride", "groom",
    "uncle", "aunt", "cousin", "grandmother", "grandfather", "grandparent",
    "friend", "neighbor", "neighbour", "stranger", "guest", "visitor",
    "teacher", "student", "pupil", "farmer", "trader", "hunter", "doctor",
    "nurse", "worker", "servant", "priest", "prophet", "king", "queen",
    "chief", "elder", "leader", "ruler", "soldier", "warrior", "thief",
    "beggar", "widow", "orphan", "twin", "youth", "adult",
    "he", "she", "him", "her", "his", "who",
]
_PERSON_PATTERN = re.compile(r"\b(" + "|".join(_PERSON_WORDS) + r")\b", re.IGNORECASE)


def _mentions_person(definition: str | None, display_text: str | None) -> bool:
    text = f"{definition or ''} {display_text or ''}"
    return bool(_PERSON_PATTERN.search(text))


COMPOSITIONS = [
    "a three-quarter view",
    "a front-facing view",
    "a dynamic, energetic composition",
    "a simple centered composition",
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


def build_variant_drafts(
    style: ArtStyle, definition: str, display_text: str, count: int
) -> list[tuple[str, str]]:
    """Returns (visual_prompt, human_clause) pairs - kept apart so callers
    (generate.py's LLM rewrite pass) can rewrite visual_prompt freely while
    passing human_clause through untouched. human_clause is "" for a word
    _mentions_person doesn't flag as involving a depicted person at all."""
    concept = definition or display_text
    compositions = _sample_without_replacement(COMPOSITIONS, count)
    backgrounds = _sample_without_replacement(BACKGROUNDS, count)
    framings = _sample_without_replacement(FRAMINGS, count)
    rendering_variants = _sample_without_replacement(style.rendering_variants, count)

    if _mentions_person(definition, display_text):
        descriptors = _sample_without_replacement(HUMAN_DESCRIPTORS, count)
    else:
        descriptors = [None] * count

    drafts = []
    for i in range(count):
        visual = (
            f"{concept}, {compositions[i]}, {framings[i]}, {backgrounds[i]}, "
            f"{style.base_prompt}, {rendering_variants[i]}."
        )
        if descriptors[i] is None:
            clause = ""
        elif descriptors[i] == WHITE_EUROPEAN_DESCRIPTOR:
            clause = f"Depict {descriptors[i]}."
        else:
            clause = f"Depict {descriptors[i]}, not a white Western appearance."
        drafts.append((visual, clause))
    return drafts


def compose(visual: str, clause: str) -> str:
    return f"{visual} {clause}".strip()


def build_variant_prompts(style: ArtStyle, definition: str, display_text: str, count: int) -> list[str]:
    return [compose(v, c) for v, c in build_variant_drafts(style, definition, display_text, count)]


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

    def rewrite_batch(self, style: ArtStyle, visual_prompts: list[str]) -> list[str]:
        """Rewrites all of one word's VISUAL prompts together (one call,
        not N) so the model can see the full set and is explicitly told to
        push them apart - see module docstring on why divergence, not
        average quality, is the target. Deliberately never sees the human-
        diversity clause (build_variant_drafts keeps it separate) - an
        earlier version passed the whole sentence through and the model
        turned a conditional "if this depicts a person" hedge into a flat
        assertion, putting a person into an inanimate object's image (see
        module docstring). Falls back to the mechanical visual prompts
        unchanged if the model errors or its reply doesn't parse back into
        exactly len(visual_prompts) lines."""
        n = len(visual_prompts)
        numbered_drafts = "\n".join(f"{i + 1}. {p}" for i, p in enumerate(visual_prompts))
        messages = [
            {
                "role": "system",
                "content": (
                    f'You write prompts for a text-to-image model, in a style called '
                    f'"{style.label}". You are given {n} draft prompts, each a variation '
                    "of the same illustration concept in that style. Rewrite each into one "
                    "natural, well-formed sentence, keeping its meaning and style description "
                    "intact - do not add any people, characters, or human figures that are not "
                    "already explicitly named in the draft. Only the single best-looking image "
                    f"of the {n} will be kept and the rest thrown away, so make the {n} "
                    "rewritten prompts as different from each other as you can in composition "
                    "and visual interpretation of the concept - favor bold variation between "
                    "them over keeping them similar. "
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
                return visual_prompts
            return [rewritten[i] for i in range(1, n + 1)]
        except Exception as exc:  # noqa: BLE001 - any failure just falls back
            print(f"  (LLM rewrite skipped: {exc})")
            return visual_prompts

    def unload(self):
        del self.model
        self._torch.cuda.empty_cache()

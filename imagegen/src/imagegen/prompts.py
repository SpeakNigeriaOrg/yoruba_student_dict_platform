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
# wants visible paper texture instead) - build_variant_drafts and
# LocalLLMRewriter both take an ArtStyle (styles.py) rather than assuming
# one hardcoded look, so adding a style is adding one styles.py entry, not
# touching this module.
#
# A full-DB run (476 words, all 3 styles) turned up a second, bigger
# problem than the style layer: concrete nouns ("star", "father", "plate")
# generated well, but bare verbs ("give", "look"), locative phrases ("on
# the ground"), and idiomatic phrases ("it is enough") either collapsed
# into a generic standing figure with no depicted action, or produced a
# meaningless abstract shape. A raw dictionary gloss like "give" or "to
# look" simply isn't a description of anything visual - no amount of style
# wrapping fixes that. So there are now three layers, not two:
#
#   1. LocalLLMRewriter.illustration_brief (generate.py calls this first,
#      per word) turns the raw gloss into either a concrete, literally-
#      depictable visual SCENE (inventing a subject/action for bare verbs
#      and phrases - "give" -> "a person handing a wrapped gift to another
#      person with both hands"), or decides the concept has no visual
#      referent at all (a pronoun, aspect marker, conjunction, or
#      idiomatic phrase/sentence) and should be skipped entirely rather
#      than generating something meaningless. This also replaces the old
#      keyword-heuristic guess at whether a person is depicted with an
#      actual per-word LLM judgment, grounded in the scene it just wrote.
#   2. A mechanical template (this module, no model calls) builds N
#      structurally-different prompts per word by sampling slots WITHOUT
#      replacement, using the brief's scene as the concept. This is what
#      --no-llm falls back to when it skips the LLM entirely - it still
#      produces usable output for concrete nouns, and inherits the same
#      generic-figure weakness for verbs/phrases that motivated layer 1 in
#      the first place. That mode also never adds the human-diversity
#      clause below (always involves_person=False) rather than guessing
#      with a keyword heuristic - an earlier version tried exactly that
#      and it false-positived on "you", whose own gloss is "...second-
#      person singular... pronoun" ("person" there is grammar jargon, not
#      a depicted human). A hand-written word list will always have
#      another case like that; the actual fix was asking the LLM per word
#      instead (illustration_brief, below) - --no-llm just accepts the
#      smaller cost of no diversity clause for that mode's words, rather
#      than resurrecting a rule that can't cover every case.
#   3. LocalLLMRewriter.rewrite_batch rephrases all N of one word's visual
#      prompts together into natural sentences, explicitly told to diverge
#      them further apart rather than converge them. Any failure (parse
#      mismatch, model error) falls back to the mechanical prompts
#      unchanged - an unattended overnight batch must never crash or stall
#      on an LLM step.
#
# The human-diversity clause is kept structurally separate from layer 3
# (build_variant_drafts returns (visual, clause) pairs, and the rewrite in
# generate.py only ever sees `visual`) after the abo_plate ("plate/bowl")
# smoke test caught it going badly wrong: a person's portrait came back
# painted where the plate should have been, in multiple styles. Two
# compounding causes, both fixed:
#   - the clause used to be a conditional sentence ("if the illustration
#     depicts a human being, depict X") glued onto every prompt regardless
#     of concept. Text-to-image models don't reliably honor "if"
#     conditions - mentioning "a person" at all tends to make one appear -
#     and the old rewrite pass made it worse by flattening the conditional
#     into a flat "featuring a Latino person" assertion.
#   - COMPOSITIONS included "a dynamic action pose", which itself implies
#     a body, applied to a definition that was just an inanimate object.
# The fix: decide ONCE per word whether the concept involves a depicted
# human being at all (from the LLM brief when there is one; otherwise
# always no - see above). If not, no human-descriptor text is ever
# generated for that word, in any variant - not even conditionally. If so,
# the descriptor is a direct instruction ("depict a Black West African
# person"), not a hedge, since a person is
# already known to belong in frame.
import re
from dataclasses import dataclass

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
    import random

    picks: list[str] = []
    while len(picks) < count:
        picks.extend(random.sample(options, len(options)))
    return picks[:count]


def build_variant_drafts(
    style: ArtStyle, concept: str, count: int, involves_person: bool
) -> list[tuple[str, str]]:
    """Returns (visual_prompt, human_clause) pairs - kept apart so callers
    (generate.py's LLM rewrite pass) can rewrite visual_prompt freely while
    passing human_clause through untouched. `concept` should already be a
    concrete, depictable description (an illustration_brief's scene, or -
    in --no-llm mode - the raw definition/display_text) and
    `involves_person` an already-made decision (from the brief, or
    _mentions_person as a fallback) - this function no longer makes either
    call itself, so it stays a plain, easily-tested function of its
    inputs."""
    compositions = _sample_without_replacement(COMPOSITIONS, count)
    backgrounds = _sample_without_replacement(BACKGROUNDS, count)
    framings = _sample_without_replacement(FRAMINGS, count)
    rendering_variants = _sample_without_replacement(style.rendering_variants, count)

    if involves_person:
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


def build_variant_prompts(style: ArtStyle, concept: str, count: int, involves_person: bool) -> list[str]:
    return [compose(v, c) for v, c in build_variant_drafts(style, concept, count, involves_person)]


@dataclass
class IllustrationBrief:
    scene: str
    involves_person: bool


_NUMBERED_LINE = re.compile(r"^\s*(\d+)[.):]\s*(.+)$")
_SCENE_LINE = re.compile(r"SCENE:\s*(.+)", re.IGNORECASE)
_PERSON_LINE = re.compile(r"PERSON:\s*(yes|no)", re.IGNORECASE)


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

    def _generate(self, messages, max_new_tokens: int) -> str:
        text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        inputs = self.tokenizer(text, return_tensors="pt").to(self.model.device)
        with self._torch.no_grad():
            output_ids = self.model.generate(
                **inputs, max_new_tokens=max_new_tokens, do_sample=True, temperature=0.7,
            )
        new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        reply = self.tokenizer.decode(new_tokens, skip_special_tokens=True)
        # Qwen3 can emit a <think>...</think> block even with
        # enable_thinking=False on some snapshots - only the part after it
        # (if any) is the actual reply.
        return reply.rsplit("</think>", 1)[-1]

    def illustration_brief(self, definition: str | None, display_text: str) -> IllustrationBrief | None:
        """Turns a raw dictionary gloss into a concrete, drawable scene, or
        decides the concept has no visual referent at all and returns None
        (generate.py skips the word entirely rather than generating
        something meaningless - see module docstring). Falls back to the
        raw gloss, with no human-descriptor diversity (involves_person is
        always False in this fallback - see module docstring on why that's
        preferred over a keyword guess), if the model errors or its reply
        doesn't parse, rather than losing the word."""
        messages = [
            {
                "role": "system",
                "content": (
                    "You help prepare dictionary entries for illustration. Given a word's "
                    "English gloss, decide: can this be drawn as ONE clear static picture a "
                    "child could recognize? Concrete nouns (animals, objects, people, places) "
                    "almost always can. ANY verb - even a bare infinitive with no object, like "
                    "\"give\" or \"look\" - must ALWAYS get a concrete scene invented for it, "
                    "never be skipped: invent a plausible subject and action, e.g. \"give\" "
                    "becomes \"a person handing a wrapped gift to another person with both "
                    "hands\", and \"look\" becomes \"a person shading their eyes with one hand "
                    "while gazing off into the distance\". Prepositional/locative phrases work "
                    "the same way - \"on the ground\" becomes \"a ball resting on the ground\". "
                    "Only skip words with NO visual referent at all: pronouns, aspect/tense "
                    "markers, conjunctions, degree words, discourse particles, or an idiomatic "
                    "phrase/full sentence with no single depictable subject (e.g. \"it is "
                    "enough\").\n\n"
                    "NEVER mention a color, even an obvious real-world one - color is decided "
                    "entirely by the illustration style afterward, and naming one here can "
                    "clash with it. Write \"a star\", never \"a white star\" or \"a yellow "
                    "star\"; \"a leaf\", never \"a green leaf\". For a concept that's already a "
                    "single concrete object/animal/person with nothing else to add, the scene "
                    "is just that subject, plainly named - do not invent extra realistic detail "
                    "it doesn't need.\n\n"
                    "Reply in EXACTLY one of these two forms, nothing else:\n"
                    "SKIP\n"
                    "or two lines:\n"
                    "SCENE: <one concrete sentence describing exactly what is drawn, with a "
                    "subject and, if applicable, an action - no style, color, or artistic "
                    "instructions>\n"
                    "PERSON: yes|no  (whether that scene depicts a human being)"
                ),
            },
            {"role": "user", "content": f'Word: "{display_text}"\nGloss: {definition or "(no definition)"}'},
        ]
        try:
            reply = self._generate(messages, max_new_tokens=120)
        except Exception as exc:  # noqa: BLE001 - any failure just falls back
            print(f"  (illustration brief skipped: {exc})")
            return IllustrationBrief(scene=definition or display_text, involves_person=False)

        if reply.strip().upper().startswith("SKIP"):
            return None

        scene_match = _SCENE_LINE.search(reply)
        if not scene_match:
            # Malformed reply - fall back rather than silently lose the word.
            return IllustrationBrief(scene=definition or display_text, involves_person=False)
        person_match = _PERSON_LINE.search(reply)
        involves_person = bool(person_match) and person_match.group(1).lower() == "yes"
        return IllustrationBrief(scene=scene_match.group(1).strip(), involves_person=involves_person)

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
            reply = self._generate(messages, max_new_tokens=config.LLM_MAX_NEW_TOKENS_PER_VARIANT * n)
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

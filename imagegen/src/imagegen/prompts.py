# Prompt construction for bulk multi-style generation.
#
# The goal here is NOT "make every one of the N variants good" - it's
# "maximize the odds at least one of the N is a hit". review.py's job is
# picking the single best of N and discarding the rest; nothing ever
# averages them. That means diversity *between* the N variants in one
# word's batch is the thing worth optimizing for, even at the cost of a
# variant or two coming out mediocre or off-style - a batch of 4 near-
# identical good prompts is worse for this pipeline than a batch of 4
# genuinely different attempts, one of which lands.
#
# A full-DB run (476 words, all 3 styles) turned up bigger problems than
# the style layer, in two rounds:
#
#   Round 1: concrete nouns ("star", "father", "plate") generated well,
#   but bare verbs ("give", "look"), locative phrases ("on the ground"),
#   and idiomatic phrases ("it is enough") either collapsed into a generic
#   standing figure with no depicted action, or produced a meaningless
#   abstract shape. A raw dictionary gloss like "give" or "to look" simply
#   isn't a description of anything visual.
#
#   Round 2, after fixing round 1: a single shared scene per word, reused
#   across all N variants with only composition/framing/style varied,
#   turned out to hide two more failures the "diversify N variants" idea
#   was supposed to prevent:
#     - "ball" rendered as a soccer ball in all 4 variants, every style -
#       "ball" is a CATEGORY with many common real-world referents
#       (soccer/basket/beach/tennis ball), and nothing ever asked for a
#       different one per variant, so the model's single strongest prior
#       won every time.
#     - "father" risked reading as just "a man" with no depicted child -
#       a relationship/role noun (father, teacher, doctor...) only means
#       what it means in reference to another party; a solo adult doesn't
#       communicate "father" any more than it communicates "person".
#     - the illustrability gate itself was a single up-or-down judgment
#       call with no room to search harder - it gave up on "you" (a
#       pronoun) and "it is enough" (an idiom) when both have real,
#       concrete depictions once you look for them: pointing at the
#       viewer is a genuine flashcard/emoji convention for "you", and "it
#       is enough" has an obvious pragmatic scene (someone declining more
#       food). A single-shot decision is exactly the failure mode the
#       rest of this module is built to avoid elsewhere.
#
# So illustration_scenes (on LocalLLMRewriter, generate.py calls it first,
# per word) produces --count DIFFERENT candidate scenes in one call, not
# one shared scene, and is instructed to: vary the concrete referent for
# category-like concepts, always include the other party for
# relationship/role concepts, and search for a pointing-gesture or
# pragmatic-use-case depiction before concluding a word has no visual
# referent at all. Only true grammatical glue (conjunctions, copulas, bare
# tense/aspect markers with no independent meaning) should still return
# None, and generate.py skips those words entirely rather than generating
# something meaningless.
#
# From there:
#   2. A mechanical template (this module, no model calls) builds one
#      structurally-different prompt per scene by sampling composition/
#      framing/background/rendering-style slots WITHOUT replacement. This
#      is what --no-llm falls back to when it skips the LLM entirely (one
#      scene - the raw gloss - reused for all N variants, and no human-
#      diversity clause - see below) - it still produces usable output for
#      concrete nouns, and inherits every weakness the LLM step above
#      exists to fix.
#   3. LocalLLMRewriter.rewrite_batch rephrases all N of one word's visual
#      prompts together into natural sentences, explicitly told to diverge
#      them further apart rather than converge them. Any failure (parse
#      mismatch, model error) falls back to the mechanical prompts
#      unchanged - an unattended overnight batch must never crash or stall
#      on an LLM step.
#
# The human-diversity clause is kept structurally separate from step 3
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
# human being at all (from the LLM's scenes when there are any; otherwise
# always no - a keyword heuristic tried this once and false-positived on
# "you", whose own gloss is "...second-person singular... pronoun" -
# "person" there is grammar jargon, not a depicted human; a hand-written
# word list will always have another case like that). If not involved, no
# human-descriptor text is ever generated for that word, in any variant -
# not even conditionally. If so, the descriptor is a direct instruction
# ("depict a Black West African person"), not a hedge, since a person is
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
    style: ArtStyle, concepts: list[str], count: int, involves_person: bool
) -> list[tuple[str, str]]:
    """Returns (visual_prompt, human_clause) pairs - kept apart so callers
    (generate.py's LLM rewrite pass) can rewrite visual_prompt freely while
    passing human_clause through untouched.

    `concepts` must have exactly `count` entries, one per variant -
    illustration_scenes produces a DIFFERENT concrete scene per entry when
    the concept calls for it (e.g. "a soccer ball" / "a basketball" / "a
    beach ball" / "a tennis ball" for the category "ball"), and the same
    scene repeated `count` times when it doesn't (e.g. "a star"). This
    function no longer decides that itself, or calls anything to decide
    `involves_person` - both are already-made decisions passed in, so it
    stays a plain, easily-tested function of its inputs."""
    if len(concepts) != count:
        raise ValueError(f"expected {count} concepts, got {len(concepts)}")

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
            f"{concepts[i]}, {compositions[i]}, {framings[i]}, {backgrounds[i]}, "
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


def build_variant_prompts(style: ArtStyle, concepts: list[str], count: int, involves_person: bool) -> list[str]:
    return [compose(v, c) for v, c in build_variant_drafts(style, concepts, count, involves_person)]


@dataclass
class IllustrationScenes:
    scenes: list[str]
    involves_person: bool


_PERSON_LINE = re.compile(r"PERSON:\s*(yes|no)", re.IGNORECASE)
_SCENE_N_LINE = re.compile(r"SCENE\s*(\d+)\s*:\s*(.+)", re.IGNORECASE)


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

    def illustration_scenes(self, definition: str | None, display_text: str, count: int) -> IllustrationScenes | None:
        """Produces `count` candidate concrete scenes for one word in a
        single call (not one shared scene reused `count` times - see module
        docstring on why that hid real diversity failures), or decides the
        concept has no visual referent at all and returns None (generate.py
        skips the word entirely rather than generating something
        meaningless). Falls back to the raw gloss repeated `count` times,
        with no human-descriptor diversity (involves_person is always False
        in this fallback - see module docstring on why that's preferred
        over a keyword guess), if the model errors or its reply doesn't
        parse."""
        messages = [
            {
                "role": "system",
                "content": (
                    "You help prepare dictionary entries for illustration. Given a word's "
                    "English gloss, you will propose several candidate scenes for it - static "
                    "pictures a child could recognize.\n\n"
                    "Concrete nouns (animals, objects, people, places) almost always work. ANY "
                    "verb - even a bare infinitive with no object, like \"give\" or \"look\" - "
                    "must ALWAYS get a concrete scene invented for it, never be skipped: invent "
                    "a plausible subject and action, e.g. \"give\" becomes \"a person handing a "
                    "wrapped gift to another person with both hands\". Prepositional/locative "
                    "phrases work the same way - \"on the ground\" becomes \"a ball resting on "
                    "the ground\".\n\n"
                    "If the concept is a RELATIONSHIP or ROLE that only means what it means in "
                    "reference to another party (a family role like father/mother/sibling, a "
                    "professional role like teacher/doctor/farmer, or similar), every scene MUST "
                    "include that other party doing something that makes the relationship "
                    "legible - \"father\" becomes \"a man holding the hand of a small child\", "
                    "\"teacher\" becomes \"an adult pointing at a chalkboard while children sit "
                    "and watch\". A solo adult with no context only communicates \"a person\", "
                    "not the specific role.\n\n"
                    "If the concept is a broad CATEGORY with several common, visually distinct "
                    "real-world variants (\"ball\" - soccer ball, basketball, beach ball, tennis "
                    "ball; \"fruit\" - apple, mango, banana; \"vehicle\" - car, bicycle, bus), "
                    "make your scenes depict DIFFERENT specific variants, one per scene - not "
                    "the same default example every time. If the concept is already one "
                    "specific, singular thing (a star, a specific role once its context is "
                    "established), your scenes can describe the same subject - variety there "
                    "comes from composition/rendering, handled separately afterward.\n\n"
                    "Before concluding a word has NO visual referent, search harder: (1) a "
                    "pronoun or deictic word often has a real pointing-gesture convention, the "
                    "same one flashcards and emoji use - \"you\" becomes \"a hand pointing "
                    "directly at the viewer\", \"I/me\" becomes \"a person pointing at their own "
                    "chest\", \"here\" becomes \"a hand pointing down at the ground\"; (2) an "
                    "idiomatic phrase or expression usually has a concrete real-life SITUATION "
                    "where someone would say it - depict THAT situation, not the literal words - "
                    "\"it is enough\"/\"it is okay\", said when declining more food, becomes \"a "
                    "person politely holding up a hand to decline a plate of food being offered "
                    "to them\". Only decide a word truly has no visual referent for grammatical "
                    "glue with no independent meaning at all: conjunctions (\"and\", \"but\"), a "
                    "copula, or a bare tense/aspect marker.\n\n"
                    "NEVER mention a color, even an obvious real-world one - color is decided "
                    "entirely by the illustration style afterward, and naming one here can clash "
                    "with it. Write \"a star\", never \"a white star\" or \"a yellow star\".\n\n"
                    "Reply in EXACTLY one of these two forms, nothing else:\n"
                    "SKIP\n"
                    "or, on separate lines:\n"
                    "PERSON: yes|no  (whether your scenes depict a human being)\n"
                    f"SCENE 1: <one concrete sentence - a subject and, if applicable, an action "
                    "- no style, color, or artistic instructions>\n"
                    "SCENE 2: <...>\n"
                    f"... through SCENE {count}, each one a genuinely different take, not a "
                    "reworded repeat of the last."
                ),
            },
            {"role": "user", "content": f'Word: "{display_text}"\nGloss: {definition or "(no definition)"}'},
        ]
        fallback = IllustrationScenes(scenes=[definition or display_text] * count, involves_person=False)
        try:
            reply = self._generate(messages, max_new_tokens=80 + 80 * count)
        except Exception as exc:  # noqa: BLE001 - any failure just falls back
            print(f"  (illustration scenes skipped: {exc})")
            return fallback

        if reply.strip().upper().startswith("SKIP"):
            return None

        scenes = {}
        for line in reply.splitlines():
            m = _SCENE_N_LINE.search(line)
            if m:
                scenes[int(m.group(1))] = m.group(2).strip().strip('"')

        if set(scenes) != set(range(1, count + 1)):
            # Malformed reply - fall back rather than silently lose the word.
            print(f"  (illustration scenes skipped: expected {count} SCENE lines, parsed {len(scenes)})")
            return fallback

        person_match = _PERSON_LINE.search(reply)
        involves_person = bool(person_match) and person_match.group(1).lower() == "yes"
        return IllustrationScenes(scenes=[scenes[i] for i in range(1, count + 1)], involves_person=involves_person)

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
                m = re.match(r"^\s*(\d+)[.):]\s*(.+)$", line)
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

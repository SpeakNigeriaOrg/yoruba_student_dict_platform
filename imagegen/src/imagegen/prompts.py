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
#   Round 3: even with that guidance in place, a real run skipped "to
#   cry" - a bare verb, explicitly the category the prompt said must
#   ALWAYS get a scene. That's not a wording problem to iterate on again;
#   it's proof a single blind "can this be drawn" judgment, made before
#   anything is generated, will always occasionally be wrong in ways no
#   amount of prompt tuning fully closes off. So there is no SKIP option
#   at all anymore - every word gets --count scenes, full stop. If a
#   genuinely bad batch results, that's what review.py's "reject all" is
#   for: a human decision made by looking at actual generated images,
#   which is a far more reliable place for that judgment to live than a
#   single guess made blind beforehand.
#
#   Round 4: a live review session turned up something worse than round
#   3's false SKIPs - "PERSON: yes/no", a self-report the model gave
#   alongside its own scenes, turned out to be wrong more than HALF the
#   time. A scan of 107 pending words found 58 where the scene text was
#   unambiguously human ("a man and a child walking hand in hand", "a
#   person counting ten fingers") but PERSON said no, so build_variant_
#   drafts never attached a diversity descriptor at all - the model was
#   simply left to its own default bias for the entire batch. Whatever
#   the model draws when given no ethnicity instruction at all is not
#   this project's call to leave to chance, and a self-reported boolean
#   that contradicts the scene text it was reported alongside isn't a
#   signal worth asking for again. So there's no PERSON field anymore
#   either: whether a given variant depicts a person is now decided by
#   scanning the SCENE TEXT ITSELF for a human-indicating word (see
#   _mentions_person) - grounded in text the model just wrote for a
#   concrete visual purpose, not a raw dictionary gloss (which is where
#   the OLD keyword heuristic actually failed, on linguistic jargon like
#   "second-person singular pronoun" - a scene sentence like "a man
#   holding a baby" doesn't have that problem) and not a separate
#   self-assessment the model apparently doesn't reliably get right. This
#   also fixes round 2's "father" problem more thoroughly than before:
#   the check now runs PER VARIANT, not once for the whole word, so a
#   word whose scenes mix human and non-human subjects (count -> "a
#   person counting fingers" alongside "a stack of ten books") gets the
#   descriptor only on the variants that actually need it.
#
# illustration_scenes (on LocalLLMRewriter, generate.py calls it first,
# per word) produces --count DIFFERENT candidate scenes in one call, not
# one shared scene, and is instructed to: vary the concrete referent for
# category-like concepts, always include the other party for
# relationship/role concepts, use the pointing-gesture convention for
# pronouns/deictic words, depict the real-life usage situation for
# idiomatic phrases, and even attempt a best-effort symbolic scene for
# pure grammatical glue rather than giving up.
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
# The fix: decide, per VARIANT, whether its own concept text depicts a
# human being at all (_mentions_person, scanning the concept string - see
# round 4 above on why this replaced a separate LLM self-report). If not,
# no human-descriptor text is ever generated for that variant - not even
# conditionally. If so, the descriptor is a direct instruction ("depict a
# Black West African person"), not a hedge, since a person is already
# known to belong in frame.
import re

from . import config
from .styles import ArtStyle

_PERSON_WORDS = [
    "person", "people", "human", "somebody", "someone", "anybody",
    "man", "men", "woman", "women", "boy", "girl", "child", "children", "kid", "kids", "baby", "babies", "infant",
    "father", "mother", "parent", "brother", "sister", "sibling",
    "son", "daughter", "husband", "wife", "bride", "groom",
    "uncle", "aunt", "cousin", "grandmother", "grandfather", "grandparent",
    "friend", "neighbor", "neighbour", "stranger", "guest", "visitor",
    "teacher", "student", "pupil", "farmer", "trader", "hunter", "doctor",
    "nurse", "worker", "servant", "priest", "prophet", "king", "queen",
    "chief", "elder", "leader", "ruler", "soldier", "warrior", "thief",
    "beggar", "widow", "orphan", "twin", "youth", "adult",
    "he", "she", "him", "her", "his", "they", "them", "their",
]
_PERSON_PATTERN = re.compile(r"\b(" + "|".join(_PERSON_WORDS) + r")\b", re.IGNORECASE)


def _mentions_person(text: str) -> bool:
    """Whether `text` - a scene illustration_scenes wrote, or (in --no-llm
    mode) a raw dictionary gloss - describes a human being. Grounded in
    concrete visual-scene text (or a plain gloss), not the grammar-jargon
    case that broke an earlier version of this same idea (a pronoun's own
    gloss reading "...second-person singular... pronoun" - "person" there
    is linguistics jargon, not a depicted human). A scene sentence like "a
    man holding a baby" doesn't have that failure mode."""
    return bool(_PERSON_PATTERN.search(text))


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


def build_variant_drafts(style: ArtStyle, concepts: list[str], count: int) -> list[tuple[str, str]]:
    """Returns (visual_prompt, human_clause) pairs - kept apart so callers
    (generate.py's LLM rewrite pass) can rewrite visual_prompt freely while
    passing human_clause through untouched.

    `concepts` must have exactly `count` entries, one per variant -
    illustration_scenes produces a DIFFERENT concrete scene per entry when
    the concept calls for it (e.g. "a soccer ball" / "a basketball" / "a
    beach ball" / "a tennis ball" for the category "ball"), and the same
    scene repeated `count` times when it doesn't (e.g. "a star"). Whether
    each one individually depicts a person is decided right here
    (_mentions_person, per concept, not once for the whole batch) - a
    word's scenes can mix human and non-human subjects (e.g. "twenty":
    "a stack of ten books" alongside "a person counting ten fingers"),
    and only the ones that actually depict someone get a descriptor."""
    if len(concepts) != count:
        raise ValueError(f"expected {count} concepts, got {len(concepts)}")

    compositions = _sample_without_replacement(COMPOSITIONS, count)
    backgrounds = _sample_without_replacement(BACKGROUNDS, count)
    framings = _sample_without_replacement(FRAMINGS, count)
    rendering_variants = _sample_without_replacement(style.rendering_variants, count)

    person_flags = [_mentions_person(c) for c in concepts]
    descriptors_needed = sum(person_flags)
    descriptor_pool = iter(_sample_without_replacement(HUMAN_DESCRIPTORS, descriptors_needed)) if descriptors_needed else iter([])

    drafts = []
    for i in range(count):
        visual = (
            f"{concepts[i]}, {compositions[i]}, {framings[i]}, {backgrounds[i]}, "
            f"{style.base_prompt}, {rendering_variants[i]}."
        )
        if not person_flags[i]:
            clause = ""
        else:
            descriptor = next(descriptor_pool)
            if descriptor == WHITE_EUROPEAN_DESCRIPTOR:
                clause = f"Depict {descriptor}."
            else:
                clause = f"Depict {descriptor}, not a white Western appearance."
        drafts.append((visual, clause))
    return drafts


def compose(visual: str, clause: str) -> str:
    return f"{visual} {clause}".strip()


def build_variant_prompts(style: ArtStyle, concepts: list[str], count: int) -> list[str]:
    return [compose(v, c) for v, c in build_variant_drafts(style, concepts, count)]


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

    def illustration_scenes(self, definition: str | None, display_text: str, count: int) -> list[str]:
        """Produces `count` candidate concrete scenes for one word in a
        single call (not one shared scene reused `count` times - see module
        docstring on why that hid real diversity failures). Whether each
        scene depicts a person is decided later, by scanning the scene
        text itself (_mentions_person) - not asked for here anymore (see
        module docstring, "Round 4": a separate PERSON: self-report this
        method used to request was wrong more than half the time, even
        against its own scene text).

        There is deliberately no "give up, this can't be drawn" option. An
        earlier version let the model reply SKIP for words it judged to
        have no visual referent, explicitly reserved for pure grammatical
        glue - and a real run skipped "to cry" anyway, despite being told
        point-blank that any verb must always get a scene. A single blind
        judgment call before anything is even generated is exactly the
        failure mode the rest of this module exists to avoid elsewhere:
        the answer isn't a better-worded escape hatch, it's removing the
        escape hatch and instead paying for the (cheap) generation attempt
        - review.py's "reject all" is where a genuinely bad batch gets
        caught, by a human looking at actual images, not by a single LLM
        guess made blind beforehand.

        Falls back to the raw gloss repeated `count` times if the model
        errors or its reply doesn't parse."""
        messages = [
            {
                "role": "system",
                "content": (
                    "You help prepare dictionary entries for illustration. Given a word's "
                    "English gloss, you propose several candidate scenes for it - static "
                    "pictures a child could recognize. Every word gets scenes; there is no "
                    "option to skip one.\n\n"
                    "Concrete nouns (animals, objects, people, places) almost always work. ANY "
                    "verb - even a bare infinitive with no object, like \"give\", \"look\", or "
                    "\"cry\" - gets a concrete scene invented for it: a plausible subject and "
                    "action, e.g. \"give\" becomes \"a person handing a wrapped gift to another "
                    "person with both hands\", \"cry\" becomes \"a child with tears streaming "
                    "down their face\". Prepositional/locative phrases work the same way - \"on "
                    "the ground\" becomes \"a ball resting on the ground\".\n\n"
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
                    "When choosing what a scene actually shows, think like a pictogram "
                    "designer, not a photographer: pick the single most identifiable angle or "
                    "moment for the subject - a side profile for most animals and objects, the "
                    "peak instant of an action (a ball already released mid-throw, not the "
                    "wind-up) - rather than an ambiguous or in-between pose. Let one or two "
                    "exaggerated, defining features carry the recognition (long ears on a "
                    "rabbit, the specific hand shape of a gesture) instead of trying to include "
                    "every literal detail. Keep exactly one clear subject per scene - two "
                    "equally-weighted things to look at reads as cluttered, not as richer.\n\n"
                    "For a pronoun or deictic word, use the pointing-gesture convention "
                    "flashcards and emoji use - \"you\" becomes \"a hand pointing directly at "
                    "the viewer\", \"I/me\" becomes \"a person pointing at their own chest\", "
                    "\"here\" becomes \"a hand pointing down at the ground\". For an idiomatic "
                    "phrase or expression, depict the concrete real-life SITUATION where someone "
                    "would say it, not the literal words - \"it is enough\"/\"it is okay\", said "
                    "when declining more food, becomes \"a person politely holding up a hand to "
                    "decline a plate of food being offered to them\". Even pure grammatical glue "
                    "with no independent meaning (a conjunction, a copula, a bare tense/aspect "
                    "marker) gets a best-effort symbolic scene - e.g. a plus sign shape for "
                    "\"and\", two shapes merging into one for \"is/am/are\" - rather than nothing "
                    "at all.\n\n"
                    "NEVER mention a color, even an obvious real-world one - color is decided "
                    "entirely by the illustration style afterward, and naming one here can clash "
                    "with it. Write \"a star\", never \"a white star\" or \"a yellow star\".\n\n"
                    f"You need {count} scenes, which is enough that lazily varying one idea "
                    "runs out fast - resist settling on the first workable scene and tweaking "
                    f"it {count} times. Actively brainstorm across different axes before you "
                    "write anything: a different moment in the action (before/at the peak/"
                    "after), a different specific sub-type or example of the concept, a "
                    "different vantage point on the same idea, a different secondary detail "
                    "that changes the read. No two scenes should be recognizable as the same "
                    "idea reworded.\n\n"
                    "Reply on separate lines, nothing else:\n"
                    f"SCENE 1: <one concrete sentence - a subject and, if applicable, an action "
                    "- no style, color, or artistic instructions>\n"
                    "SCENE 2: <...>\n"
                    f"... through SCENE {count}, each one a genuinely different take, not a "
                    "reworded repeat of the last."
                ),
            },
            {"role": "user", "content": f'Word: "{display_text}"\nGloss: {definition or "(no definition)"}'},
        ]
        fallback = [definition or display_text] * count
        try:
            reply = self._generate(messages, max_new_tokens=60 + 70 * count)
        except Exception as exc:  # noqa: BLE001 - any failure just falls back
            print(f"  (illustration scenes generation failed, using raw gloss: {exc})")
            return fallback

        scenes = {}
        for line in reply.splitlines():
            m = _SCENE_N_LINE.search(line)
            if m:
                scenes[int(m.group(1))] = m.group(2).strip().strip('"')

        if set(scenes) != set(range(1, count + 1)):
            # Malformed reply - fall back rather than silently lose the word.
            print(f"  (illustration scenes unparsable, using raw gloss: expected {count} SCENE lines, parsed {len(scenes)})")
            return fallback

        return [scenes[i] for i in range(1, count + 1)]

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

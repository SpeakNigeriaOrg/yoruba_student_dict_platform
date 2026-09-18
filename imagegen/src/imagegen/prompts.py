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
#   descriptor only on the variants that actually need it. Round 4's own
#   word list needed a second pass too, once live output exposed the
#   gaps: no plural forms at all (a scene saying "Friends" or "Soldiers"
#   matched neither, since the list only had the singular), several
#   missing categories entirely ("family", "athlete", "choir", "team"),
#   and one real false-positive risk in the fix itself - generic plural
#   pronouns ("they"/"them"/"their") refer back to whatever was just
#   mentioned, human or not, and a bird scene phrased "...one more bird
#   joining them" matched on exactly that. Kept singular gendered pronouns
#   (he/she/him/her/his - essentially never used for an object or animal
#   in this kind of scene text) and dropped the plural ones; added the
#   missing categories with their plurals; deliberately still excluded
#   "group"/"band" (both have common non-human meanings - "a group of
#   ten birds", a rubber/color band - that would reintroduce the abo_
#   plate-style false positive this whole design exists to avoid).
#
#   Round 5: even with that word list fixed, a live regeneration run
#   still produced real misses - "a person listening to a box with
#   earphones" (radio) with no descriptor, despite "person" being right
#   there in the text and squarely in the word list. The actual bug was
#   structural, not lexical: the human-clause decision ran on the scene
#   BEFORE LocalLLMRewriter.rewrite_batch rephrased it, and the clause was
#   then just carried through unchanged, paired with whatever the rewrite
#   produced. If rewriting introduced a person that wasn't explicit in the
#   original scene (very plausible - rewriting adds narrative specificity,
#   and "a box with earphones" is a short step from "a person listening to
#   a box with earphones"), the decision was already stale by the time the
#   final prompt existed. Fixed by moving the decision to run on the LAST
#   text before image generation - attach_human_clauses takes already-
#   rewritten visuals, not the pre-rewrite concepts build_variant_visuals
#   started from.
#
#   Round 6 (found via videogen, 2026-09-16, but the bug was already live
#   here): the first real production smoke test of the video branch
#   attached "Depict a South Asian person, not a white Western appearance"
#   to a video of "chicken" - no person anywhere in the scene. The match
#   wasn't in the scene text at all: _mentions_person scans the FINAL
#   visual string, which is concept + style.base_prompt + rendering
#   variant all merged together (see build_variant_visuals) - and every
#   ArtStyle's base_prompt at the time contained the word "children"
#   ("children's-book educational illustration", "...for young children",
#   "children's educational illustration") as a stylistic descriptor of
#   the illustration GENRE, not a statement about scene content. _PERSON_
#   WORDS includes "child"/"children" (for when a scene genuinely depicts
#   one), so every single cartoon/collage/textile prompt ever generated -
#   regardless of subject - false-positived on its OWN style text. This
#   is the abo_plate failure mode again, from a source Round 4's fix never
#   considered: the contaminating word doesn't have to come from the
#   scene or the rewrite, the style boilerplate appended to EVERY variant
#   is just as much a place a stray person-word can hide, and it hides
#   there for every word in the corpus at once rather than one-off.
#   First fixed by rewording every style's base_prompt to avoid any word
#   in _PERSON_WORDS ("storybook-style", "young readers", "young-reader" -
#   see styles.py) - a same-day interim fix, kept as a standing invariant
#   (see the guardrail comment on ArtStyle in styles.py) rather than
#   thrown away once Round 7 below made it no longer load-bearing on its
#   own.
#
#   Round 7 (same day, one word later in the same production run):
#   rewording the style text fixed the false person-match, but a
#   completely different failure showed up looking at the actual output -
#   "alangba_lizard"'s 4 rewritten prompts had all silently DROPPED the
#   literal "flat vector clip-art illustration... storybook-style
#   educational illustration" phrase in favor of vaguer paraphrases
#   ("bold flat colors", "a crisp icon-like presentation"), even though
#   rewrite_batch's own system prompt said to keep "style description
#   intact". Not a wording problem to iterate on again (same lesson as
#   Round 3's SKIP option and Round 4's PERSON: field): a live comparison
#   against an earlier successful run showed the SAME instruction
#   sometimes preserved the style phrase verbatim and sometimes didn't,
#   for no visible reason - an LLM asked to rewrite something into "one
#   natural sentence" while also being told to preserve a specific chunk
#   of that same text verbatim is not a reliable place to enforce
#   "verbatim". Fixed structurally instead: build_variant_visuals was
#   split into build_variant_scenes (concept + composition/framing/
#   background only - CONTENT, the only thing rewrite_batch ever sees or
#   changes) and apply_style (mechanically appends base_prompt and a
#   rendering_variant AFTER rewrite_batch runs, never passed through the
#   LLM at all). Style text is now literally incapable of being
#   paraphrased, by construction, rather than by instruction - and as a
#   side effect, attach_human_clauses now decides personhood from
#   content-only text, so Round 6's false match couldn't recur even
#   without its own fix (which stays in place anyway - see styles.py).
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
# (attach_human_clauses returns (visual, clause) pairs, and rewrite_batch
# in generate.py only ever sees plain visual strings) after the abo_plate
# ("plate/bowl") smoke test caught it going badly wrong: a person's portrait came back
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

# An enumerated list, not a suffix/pattern heuristic (e.g. "words ending in
# -er/-or often name a person") - that would catch "teacher"/"singer" but
# also "mirror"/"computer"/"ladder", reintroducing the exact false-positive
# failure this project already paid for once (a keyword match landing on
# an inanimate object's scene and getting a person's portrait painted onto
# it - see the abo_plate/"plate" incident in this module's docstring).
# A missed word here just means a batch defaults to the model's own bias
# (bad, but the same failure the whole point of this function is to
# reduce, not a new one); a false match injects a person into a scene that
# has none (worse, and previously a real bug). Every regular-plural noun
# below also matches its plural via the trailing `s?` in the compiled
# pattern - "friend" catching "Friends" is what "a_we" ("we") exposed
# missing the first time this list shipped.
_PERSON_WORDS = [
    "person", "people", "human", "somebody", "someone", "anybody",
    "man", "men", "woman", "women", "boy", "girl", "child", "children", "kid", "kids", "baby", "babies", "infant",
    "father", "mother", "parent", "brother", "sister", "sibling",
    "son", "daughter", "husband", "wife", "bride", "groom",
    "uncle", "aunt", "cousin", "grandmother", "grandfather", "grandparent",
    "friend", "neighbor", "neighbour", "stranger", "guest", "visitor",
    "teacher", "student", "pupil", "classmate", "colleague",
    "farmer", "trader", "hunter", "doctor", "nurse", "worker", "villager",
    "servant", "priest", "prophet", "king", "queen",
    "chief", "elder", "leader", "ruler", "soldier", "warrior", "guard", "officer",
    "thief", "beggar", "widow", "orphan", "twin", "youth", "adult", "citizen", "tourist",
    "athlete", "player", "performer", "singer", "dancer", "musician", "artist",
    "family", "families", "team", "crowd", "audience", "choir",
    # Deliberately NOT here: "group", "band" - both have common non-human
    # meanings in exactly this kind of scene text ("a group of ten birds",
    # a rubber/color band), so including them would trade a missed
    # descriptor for the worse failure (a person injected into a non-human
    # scene) on cases already seen in this project's own output. Same
    # reasoning ruled out "they"/"them"/"their" - a plural pronoun refers
    # back to whatever was just mentioned, human or not ("...one more bird
    # joining them" is what caught this in testing), where a singular
    # gendered pronoun is a much safer bet since scene text essentially
    # never uses "he"/"she" for an object or animal.
    "he", "she", "him", "her", "his",
]
_PERSON_PATTERN = re.compile(r"\b(" + "|".join(_PERSON_WORDS) + r")s?\b", re.IGNORECASE)


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
# "a Black West African person" appears twice (with "a Black person" as a
# second, differently-worded entry) rather than once like every other
# category - a deliberate soft rebalancing, not a rule: _sample_without_
# replacement cycles the whole list once before repeating anything, so
# this doubles Black/West African representation's odds per draw (2/7
# slots vs 1/7 for every other category) without ever making it the
# guaranteed or majority outcome. Two distinct phrasings rather than one
# literal duplicate so the extra weight doesn't also mean less phrasing
# variety within that outcome.
HUMAN_DESCRIPTORS = [
    "a Black West African person",
    "a Black person",
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


def build_variant_scenes(concepts: list[str], count: int) -> list[str]:
    """Purely mechanical, CONTENT ONLY: one structurally-different scene
    sentence-fragment per concept, sampling composition/framing/background
    slots WITHOUT replacement. Deliberately carries no style text at all -
    see apply_style for that, and the module docstring's "Round 6" on why
    style text and content text must be kept apart through both the human-
    clause decision and the LLM rewrite step, not merged before either
    touches them.

    `concepts` must have exactly `count` entries, one per variant -
    illustration_scenes produces a DIFFERENT concrete scene per entry when
    the concept calls for it (e.g. "a soccer ball" / "a basketball" / "a
    beach ball" / "a tennis ball" for the category "ball"), and the same
    scene repeated `count` times when it doesn't (e.g. "a star")."""
    if len(concepts) != count:
        raise ValueError(f"expected {count} concepts, got {len(concepts)}")

    compositions = _sample_without_replacement(COMPOSITIONS, count)
    backgrounds = _sample_without_replacement(BACKGROUNDS, count)
    framings = _sample_without_replacement(FRAMINGS, count)

    return [
        f"{concepts[i]}, {compositions[i]}, {framings[i]}, {backgrounds[i]}."
        for i in range(count)
    ]


def apply_style(style: ArtStyle, scenes: list[str], count: int) -> list[str]:
    """Mechanically PREPENDS this style's base_prompt and one (without-
    replacement-sampled) rendering_variant to each already-finished scene
    sentence - NEVER passed through the LLM rewrite step, so the style
    identity that keeps a whole corpus visually consistent can't be
    paraphrased away the way an instruction to "keep it intact" alone
    failed to reliably guarantee (see module docstring's "Round 6": a live
    production run had rewrite_batch drop the literal "flat vector
    clip-art illustration..." phrase from prompts on some words but not
    others, unpredictably, in favor of a vaguer paraphrase - an LLM
    rewrite is not a place to trust a "never change this part" rule).
    Call this AFTER rewrite_batch, on its output - style was never part of
    what got rewritten in the first place.

    Style comes FIRST in the final prompt, scene second - not the
    mechanical layer's original order (scene, then style, appended). Two
    reasons: a model's own weighting tends to favor earlier tokens, so
    style shouldn't be buried after everything else; and rewrite_batch's
    own output is a discursive, often long natural-language sentence -
    exactly the kind of text that can bury or dilute a short style
    descriptor if it comes after."""
    if len(scenes) != count:
        raise ValueError(f"expected {count} scenes, got {len(scenes)}")
    rendering_variants = _sample_without_replacement(style.rendering_variants, count)
    return [f"{style.base_prompt}, {rendering_variants[i]}. {scenes[i]}" for i in range(count)]


def attach_human_clauses(visuals: list[str]) -> list[tuple[str, str]]:
    """Returns (visual, human_clause) pairs, one per input visual.

    MUST be called on the LAST CONTENT text that will ever change before
    an image is generated from it - i.e. AFTER LocalLLMRewriter.
    rewrite_batch, not before, but (as of "Round 6") BEFORE apply_style,
    not after: apply_style only ever adds style text that is itself
    guaranteed free of any word in _PERSON_WORDS (see the invariant on
    ArtStyle in styles.py), so calling this right after rewrite_batch's
    output is still "the last text that can change personhood", even
    though apply_style runs afterward. An earlier version decided this
    from the pre-rewrite concept and just carried the clause through
    rewriting unchanged; a live run showed that breaking in practice - "a
    box with earphones playing music" (no person) got rewritten to "a
    person listening to a box with earphones" (very much a person), and
    the clause decision, made before that rewrite, never noticed.
    Deciding per FINAL content instead of once per word also still
    handles a batch mixing human and non-human subjects (e.g. "twenty": "a
    stack of ten books" alongside "a person counting ten fingers") - only
    the ones that actually depict someone, in their actual final wording,
    get a descriptor."""
    person_flags = [_mentions_person(v) for v in visuals]
    descriptors_needed = sum(person_flags)
    descriptor_pool = iter(_sample_without_replacement(HUMAN_DESCRIPTORS, descriptors_needed)) if descriptors_needed else iter([])

    pairs = []
    for visual, involves_person in zip(visuals, person_flags):
        if not involves_person:
            clause = ""
        else:
            descriptor = next(descriptor_pool)
            if descriptor == WHITE_EUROPEAN_DESCRIPTOR:
                clause = f"Depict {descriptor}."
            else:
                clause = f"Depict {descriptor}, not a white Western appearance."
        pairs.append((visual, clause))
    return pairs


def compose(visual: str, clause: str) -> str:
    return f"{visual} {clause}".strip()


def build_variant_prompts(style: ArtStyle, concepts: list[str], count: int) -> list[str]:
    """Convenience for callers with no rewrite step (e.g. --no-llm mode):
    build mechanical scenes, decide human clauses from them, then apply
    the style - since there's no rewrite step to invalidate the human-
    clause decision here, scene and style could technically be merged
    first without the "Round 6" risk, but keeping the same scene-then-
    style order as the LLM path means there's only one code path to
    reason about, not two."""
    scenes = build_variant_scenes(concepts, count)
    styled = apply_style(style, scenes, count)
    pairs = attach_human_clauses(scenes)
    return [compose(styled[i], pairs[i][1]) for i in range(count)]


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

    def generate_reply(self, messages, max_new_tokens: int) -> str:
        """Public entry point for a caller with its own prompt content (e.g.
        videogen.prompts' motion-direction step) that wants this already-
        loaded model without duplicating the load/unload lifecycle above.
        Same model, same generation settings as every call in this module -
        only the messages and their purpose differ."""
        return self._generate(messages, max_new_tokens)

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

    def rewrite_batch(self, style: ArtStyle, scene_prompts: list[str]) -> list[str]:
        """Rewrites all of one word's SCENE prompts together (one call,
        not N) so the model can see the full set and is explicitly told to
        push them apart - see module docstring on why divergence, not
        average quality, is the target. `scene_prompts` never contains
        style text (see "Round 6" - style.base_prompt/rendering_variants
        are applied AFTER this, by apply_style, mechanically, never
        rewritten - an instruction to preserve them through a rewrite
        turned out not to be reliable). Deliberately never sees the
        human-diversity clause either (attach_human_clauses runs on the
        output of this method, afterward, not before - see module
        docstring's "Round 5") - an earlier version passed the whole
        sentence through and the model turned a conditional "if this
        depicts a person" hedge into a flat assertion, putting a person
        into an inanimate object's image (see module docstring). Falls
        back to the mechanical scene prompts unchanged if the model errors
        or its reply doesn't parse back into exactly len(scene_prompts)
        lines."""
        n = len(scene_prompts)
        numbered_drafts = "\n".join(f"{i + 1}. {p}" for i, p in enumerate(scene_prompts))
        messages = [
            {
                "role": "system",
                "content": (
                    f"You write SCENE descriptions for a text-to-image model. These "
                    f'will later be rendered in a style called "{style.label}" - a '
                    "separate step, after this one, adds that style's own visual "
                    "language, so your job is only the scene itself: what is in frame "
                    "and what it's doing, not how it's rendered. Keep your wording "
                    "compatible with that later style (don't describe photographic "
                    "lighting, textures, or realism if the style is flat and graphic), "
                    f"but never state the style outright - that's added separately. "
                    f"You are given {n} draft scenes, each a variation of the same "
                    "illustration concept. Rewrite each into one natural, well-formed "
                    "sentence, keeping its meaning intact - do not add any people, "
                    "characters, or human figures that are not already explicitly named "
                    f"in the draft. Only the single best-looking image of the {n} will be "
                    f"kept and the rest thrown away, so make the {n} rewritten scenes as "
                    "different from each other as you can in composition and visual "
                    "interpretation of the concept - favor bold variation between them "
                    "over keeping them similar. "
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
                return scene_prompts
            return [rewritten[i] for i in range(1, n + 1)]
        except Exception as exc:  # noqa: BLE001 - any failure just falls back
            print(f"  (LLM rewrite skipped: {exc})")
            return scene_prompts

    def unload(self):
        del self.model
        self._torch.cuda.empty_cache()

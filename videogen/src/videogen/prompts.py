# Thin video-specific layer over imagegen.prompts, reused rather than
# duplicated (see videogen/pyproject.toml's path dependency on
# yoruba-imagegen). The scene-generation and human-diversity logic in
# imagegen.prompts encodes several real, hard-won fixes (category
# collapse, missing relationship context, unreliable self-reported
# fields, "diversity collapse" from templated prompting - see its own
# module docstring) that have nothing to do with images specifically; a
# word's video needs the exact same "what should even be in frame"
# decision an image does, just with motion added on top once that's
# settled.
#
# Division of labor: imagegen.prompts builds the STILL-FRAME visual, in
# strict phases that must not merge (see that module's "Round 7"): scene
# CONTENT first (build_variant_scenes), rewritten for divergence while
# still content-only, THEN style applied mechanically (apply_style, never
# passed through the LLM), with the human-clause decision
# (attach_human_clauses) running on the content in between - after
# rewrite, before style. motion_and_sound_directions below is the new
# step video adds on top of all of that,
# and it is a genuinely harder problem than the still-frame one, not a
# smaller version of it: images have one axis of freedom per word (what
# to show); video has two (what to show, AND what - if anything - should
# move), and the two axes pull in different directions about as often as
# they agree. Getting this wrong is easy in both directions:
#   - Too little motion-awareness: a fixed, word-blind motion suffix ("a
#     gentle loop") is what this module shipped with first - it made
#     every clip loop cleanly and compress well, but it is actively
#     WRONG for a huge, important class of words. A word like "bounce" or
#     "spin" or "open" doesn't merely tolerate motion, it single-
#     handedly consists of a motion no still image can show at all -
#     that is the entire reason a video branch exists alongside the
#     image branch in the first place (see the top-level session
#     decision that started this package). Applying the same passive
#     ambient sway to "bounce" as to "chicken" throws away the one thing
#     video was built to add.
#   - Too much motion-eagerness, in the other direction: a word like
#     "sleep", "wait", "silence", or "patience" MEANS the absence of
#     notable activity. Animating one of these with visible business -
#     even a small one - doesn't just look busy, it contradicts the
#     word. The correct output for these is closer to still than to
#     lively, which a system that only ever asks "how should this move"
#     and never "should this move much at all" cannot produce.
#
# So this module treats "how (if at all) should this scene move" as its
# own real decision per word, argued through explicitly in one LLM call,
# the same way imagegen.prompts.illustration_scenes argues through "what
# does this word even show" rather than asking for a bare category label
# and trusting it (see that module's "Round 4": a self-reported PERSON:
# yes/no field was wrong more than half the time, even against the
# model's own scene text in the same reply). motion_and_sound_directions
# below asks for the finished per-scene motion clause directly, never a
# category name first - the taxonomy in its system prompt exists to make
# the model reason well about which clause to write, not to be echoed
# back and trusted as a separate structured field.
#
# Round 8: MiniMax H3's own documented prompt format (docs/
# VIDEO_PROMPT_WRITING_GUIDE_base_en.md and _ref_en.md, shipped in the
# model's HF repo, read in full this session) is NOT free-form prose -
# it's three top-level fields (`integrated_multimodal_description` /
# `overall_soundscape` / `non_diegetic_music`), with the visual field
# itself structured as `[Shot N]` blocks (style stated at the start of
# the first shot) plus documented camera-motion vocabulary. Our clips are
# single-take (no cuts), so this collapses to one `[Shot 1]` block with
# no timestamp - see _ref_en.md section 5.2's own T2VA-vs-full-reference
# table, which confirms T2VA needs none of the reference-label/multi-shot
# machinery that guide otherwise documents for full-reference mode. This
# module now asks the LLM for a SOUND clause alongside each MOTION clause
# (same taxonomy, same call, so this doesn't cost an extra LLM pass) and
# compose_minimax_prompt below wraps the result into the model's actual
# expected shape instead of one long unstructured sentence.
import re

from imagegen.prompts import (  # noqa: F401
    LocalLLMRewriter,
    apply_style,
    attach_human_clauses,
    build_variant_scenes,
    compose,
)

from .styles import VideoStyle

_MOTION_N_LINE = re.compile(r"MOTION\s*(\d+)\s*:\s*(.+)", re.IGNORECASE)
_SOUND_N_LINE = re.compile(r"SOUND\s*(\d+)\s*:\s*(.+)", re.IGNORECASE)


def motion_and_sound_directions(
    rewriter: LocalLLMRewriter, definition: str | None, display_text: str, still_frames: list[str], style: VideoStyle,
) -> list[tuple[str, str]]:
    """One (motion clause, sound clause) pair per already-finished
    still-frame prompt in `still_frames` (post scene + rewrite + human-
    clause - i.e. exactly what would be sent to a pure image model). Must
    run inside the same LLM-resident phase as illustration_scenes/
    rewrite_batch, before generate.py unloads the rewriter and loads the
    video model - see generate.py's phase-1/phase-2 split.

    Sound rides on the same taxonomy as motion (see the system prompt
    below) rather than a second, separate LLM call: MiniMax H3 always
    denoises audio jointly with video regardless of what's asked for, so
    leaving sound purely to the model's own judgment on a batch of ~750
    unattended generations (185 words * 4 variants) is a real gap now
    that audio is kept, not discarded - see encode.py's own note on why
    "always muted" was never a safe assumption to keep.

    Falls back to `(style.motion_prompt, style.soundscape_prompt)` - the
    same pair for every scene - on any failure; an unattended overnight
    batch must never crash or stall on this step, same discipline as
    every other LLM call in this pipeline."""
    count = len(still_frames)
    fallback = [(style.motion_prompt, style.soundscape_prompt)] * count
    numbered_scenes = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(still_frames))
    messages = [
        {
            "role": "system",
            "content": (
                "You are choosing how a short, looping video clip should move AND "
                f"sound, for scenes illustrating one dictionary word. You will write "
                f"exactly {count} motion clauses and {count} matching sound clauses, "
                "one pair per scene below, each describing how THAT scene's own "
                "subject moves and what THAT scene's own audio should contain - "
                "never a generic instruction that could be pasted onto any scene "
                "unchanged. Motion and sound must never contradict or dilute the "
                "word's own meaning, and must never invent an action the word "
                "doesn't have. Decide which of the following applies to THIS word - "
                "do not say which one out loud, just write clauses that follow from "
                "it:\n\n"
                "- If the word's own meaning IS a physical action, movement, "
                "process, or transition (any verb of motion - run, jump, spin, "
                "fall, bounce, throw, open, pour, grow, turn - or an event/"
                "transformation - break, arrive, finish), the motion MUST depict "
                "that exact action and nothing else, as one clean cycle simple "
                "enough to loop (a ball's full rise-and-fall for \"bounce\", a "
                "door's open-then-close for \"open\") - a viewer must be able to "
                "guess the word from the motion alone, with the sound off. This is "
                "the one case where big, obvious motion is correct. Sound should be "
                "a short, concrete foley effect matching that exact action (a soft "
                "thud on landing, a creak as a door opens, a splash) - a real "
                "physical sound, never music or speech.\n\n"
                "- If the word names a relationship, exchange, or interaction "
                "between two parties (give, share, greet, help, follow, teach), the "
                "motion must show the interaction itself passing between them - an "
                "object crossing from one pair of hands to the other, a greeting "
                "gesture completing - not two figures merely standing near each "
                "other. Sound should be a soft, indistinct interaction sound (a "
                "quiet rustle, an unintelligible murmur of voices too indistinct to "
                "make out words) - never actual legible dialogue, since these are "
                "silent flashcard illustrations, not narrated scenes.\n\n"
                "- If the word names a state, duration, or absence of activity "
                "(sleep, wait, rest, silence, patience, calm, stillness), use "
                "DELIBERATELY MINIMAL motion - a slow breath, a slow blink, a "
                "barely-perceptible sway - never enough to look like an action is "
                "happening. Genuine near-stillness is the correct, honest answer "
                "here, not a compromise or a failure to find motion. Sound should "
                "match: near-silence, at most a faint ambient room tone - write "
                "\"N/A\" if nothing at all should be audible.\n\n"
                "- If the word is a quality or intensity with a natural tempo or "
                "energy (fast, slow, gentle, violent, happy, sad, excited, calm), "
                "you may use the SPEED and ENERGY of an otherwise-ambient motion as "
                "a connotative cue - a quick snappy bounce for \"fast\"/\"happy\", a "
                "slow heavy settle for \"slow\"/\"sad\" - without depicting an "
                "unrelated action the word doesn't have. Sound should carry the "
                "same tempo/energy connotatively (quick light taps for \"fast\", a "
                "slow low hum for \"slow\") without literal music.\n\n"
                "- For everything else - ordinary nouns, categories, objects, "
                "places, and any word with no motion of its own - use small, "
                "ambient, decorative motion that keeps the image visually alive "
                "without suggesting a specific action: a gentle idle sway, a soft "
                "bob, a slow ambient shimmer. This is the default, and it is the "
                "right answer for most words - resist inventing an action a plain "
                "object doesn't have just because motion is available. Sound "
                "should be minimal ambient background, or \"N/A\" if nothing "
                "natural suggests itself - do not invent a sound effect for a "
                "plain static object.\n\n"
                "In every case: never write music, a musical score, or singing "
                "(that is decided separately) and never write legible dialogue or "
                "words a viewer could make out.\n\n"
                "Keep every clause short - one or two phrases, simple, loop-"
                "friendly, nothing that needs more than a few seconds to read "
                "clearly.\n\n"
                "Reply on separate lines, nothing else:\n"
                "MOTION 1: <clause for scene 1>\n"
                "SOUND 1: <clause for scene 1, or N/A>\n"
                "MOTION 2: <...>\n"
                "SOUND 2: <...>\n"
                f"... through MOTION {count}/SOUND {count}, each pair matching its own scene."
            ),
        },
        {
            "role": "user",
            "content": f'Word: "{display_text}"\nGloss: {definition or "(no definition)"}\n\nScenes:\n{numbered_scenes}',
        },
    ]
    try:
        reply = rewriter.generate_reply(messages, max_new_tokens=70 * count)
    except Exception as exc:  # noqa: BLE001 - any failure just falls back
        print(f"  (motion/sound directions generation failed, using ambient default: {exc})")
        return fallback

    motions, sounds = {}, {}
    for line in reply.splitlines():
        m = _MOTION_N_LINE.search(line)
        if m:
            motions[int(m.group(1))] = m.group(2).strip().strip('"')
            continue
        s = _SOUND_N_LINE.search(line)
        if s:
            sounds[int(s.group(1))] = s.group(2).strip().strip('"')

    expected = set(range(1, count + 1))
    if set(motions) != expected or set(sounds) != expected:
        print(
            f"  (motion/sound directions unparsable, using ambient default: expected {count} pairs, "
            f"parsed {len(motions)} motion / {len(sounds)} sound)"
        )
        return fallback

    return [(motions[i], sounds[i]) for i in range(1, count + 1)]


def compose_minimax_prompt(still_frame: str, motion_clause: str, sound_clause: str) -> str:
    """Wrap a finished still-frame prompt (style + scene + human clause)
    plus its motion and sound clauses into MiniMax H3's own documented
    T2VA rewrite format - three top-level fields, not one free-form
    sentence (see docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md and
    _ref_en.md, both shipped in the model's own HF repo and read in full
    this session; "Round 8" in this module's docstring).

    T2VA has no reference labels, no dialogue track, and (for our
    single-take, uncut clips) no need for more than one shot, so this
    collapses the guide's general shape down to exactly what a 5s loop
    needs: one `[Shot 1]` block (style stated first, per the guide's own
    convention - independently the same "style must come first" fix this
    session already made for still-frame prompts, see apply_style) inside
    `integrated_multimodal_description`, plus the two audio fields the
    guide keeps separate from the visual description.

    non_diegetic_music is hardcoded N/A always: these are silent
    flashcard illustrations with no story to score, not narrative video -
    there is no case in this pipeline where background music is correct,
    so it is never left to chance or to an LLM guess."""
    soundscape = sound_clause.strip() or "N/A"
    return (
        f"integrated_multimodal_description: [Shot 1] {still_frame} {motion_clause}\n"
        f"overall_soundscape: {soundscape}\n"
        "non_diegetic_music: N/A"
    )

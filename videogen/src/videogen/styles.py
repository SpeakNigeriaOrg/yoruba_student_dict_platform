# Style registry - the videogen sibling of imagegen/styles.py, same
# reasoning: word_videos.video_style is free text on purpose (mirrors
# word_images.art_style - see 0010_word_images.sql and 0028_word_videos.sql),
# so adding a style is adding one VideoStyle entry here, nothing else
# changes.
#
# base_prompt for "cartoon" is deliberately the SAME visual style text as
# imagegen.styles.STYLES["cartoon"].base_prompt - a word's video and its
# image(s) should look like they belong to the same illustrated world.
#
# motion_prompt is NOT the primary source of a clip's motion anymore -
# prompts.motion_directions decides that per word, per scene (a word whose
# meaning IS an action gets motion depicting that exact action; a state/
# stillness word gets deliberately minimal motion; only the large default
# "no motion of its own" case gets ambient movement at all - see that
# module's docstring for the full taxonomy). motion_prompt here is only
# the FALLBACK used when that LLM step fails or is skipped (--no-llm) -
# it is written toward low, ambient motion on purpose because a safe,
# word-blind default has to default to the common case (most words are
# plain objects/categories with no motion of their own), not to the rarer
# "this word IS an action" case that needs the real per-word decision to
# get right. It's also still the right note for compressibility even as a
# fallback: h264/vp9 encode a mostly-static frame with small, simple,
# looping motion far smaller than one with big or noisy motion, and these
# clips need to be cheap to ship to every player on every replay.
# review_rubric says so explicitly, the same way imagegen.styles' rubrics
# tell a human reviewer what "good" means for a style relative bar rather
# than a generic one - and now also tells a reviewer to judge whether the
# motion shown actually matches what the word means, not just whether the
# motion looks calm and clean.
from dataclasses import dataclass

from imagegen.styles import STYLES as IMAGE_STYLES


@dataclass(frozen=True)
class VideoStyle:
    video_style: str  # word_videos.video_style value + candidates/{video_style}/ dir name
    label: str
    base_prompt: str
    # Same role as ArtStyle.rendering_variants (imagegen.prompts.apply_style
    # samples from this for intra-batch finish diversity) - reused directly
    # from the matching image style rather than redefined, since the still-
    # frame "look" should match; motion_prompt (below) is what's new for video.
    rendering_variants: list[str]
    motion_prompt: str
    # Fallback for MiniMax H3's own `overall_soundscape` field (see
    # prompts.py's motion_and_sound_directions and its "Round 8" note) -
    # used the same way motion_prompt is: only when the LLM step fails or
    # is skipped (--no-llm), never the primary source. Written toward
    # near-silence for the same reason motion_prompt defaults to ambient
    # motion: MiniMax H3 always denoises audio jointly with video whether
    # asked for or not, so a word-blind fallback has to name something
    # rather than leave the field to the model's own guess, and quiet
    # ambience is the safe default across almost every word.
    soundscape_prompt: str
    review_rubric: str


STYLES: dict[str, VideoStyle] = {
    "cartoon": VideoStyle(
        video_style="cartoon",
        label="Flat clip-art (animated)",
        base_prompt=IMAGE_STYLES["cartoon"].base_prompt,
        rendering_variants=IMAGE_STYLES["cartoon"].rendering_variants,
        motion_prompt=(
            "gentle, simple, looping motion, minimal camera movement, the "
            "subject performs one small clear repeating action, plain "
            "steady background with no clutter or extra movement"
        ),
        soundscape_prompt="near-silent, soft ambient room tone, no dialogue, no music, no distinct sound effects",
        review_rubric=(
            "Judge this the same way as a cartoon still image (bold flat "
            "colors, clean readable silhouette, no photorealistic shading) "
            "PLUS two motion checks. First, compression: reject anything "
            "with busy, jittery, or chaotic motion, camera shake, or a "
            "shifting/noisy background - those compress badly and are "
            "exactly what this style must avoid regardless of the word. "
            "Second, and just as important: does the motion shown actually "
            "match what the WORD means? A word that names an action "
            "(bounce, spin, open) needs to clearly show that action, even "
            "if the motion is bigger than usual for this style - reject a "
            "candidate for that kind of word if it just sits there doing "
            "nothing recognizable. A word that names a state or stillness "
            "(sleep, wait, silence) should look nearly still - reject a "
            "candidate for that kind of word if it's visibly busy or "
            "energetic. For an ordinary object/category word with no "
            "motion of its own, small ambient movement (a gentle sway or "
            "bob) is correct and doesn't need to depict anything specific. "
            "Third, sound (audio is generated jointly and kept, not muted): "
            "reject any dialogue, legible speech, or music, since these are "
            "silent flashcard illustrations with no story to narrate or "
            "score - a plausible diegetic sound effect matching the motion "
            "(a soft thud, a creak, a splash) is correct for an action "
            "word, and near-silence is correct for everything else."
        ),
    ),
}


def get(video_style: str) -> VideoStyle:
    try:
        return STYLES[video_style]
    except KeyError:
        available = ", ".join(sorted(STYLES))
        raise SystemExit(f'Unknown --video-style "{video_style}". Available: {available}') from None

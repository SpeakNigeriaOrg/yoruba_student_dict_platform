# Style registry - the thing that makes "generate in multiple styles" a
# config addition, not a rewrite. word_images.art_style is free text on
# purpose (0010_word_images.sql: "open-ended like speakers.dialect_region,
# not a fixed enum... more styles later without a migration") - this
# module is the Python side of that same design: adding a style is adding
# one ArtStyle entry below, nothing else changes.
#
# Each style carries its own rendering_variants (the intra-batch diversity
# slot - see prompts.py's module docstring on why diversity BETWEEN
# variants, not average quality, is the goal) and its own review_rubric,
# because "is this a good image" is a style-relative question: a collage
# candidate with visible paint texture and torn edges is a hit, a cartoon
# candidate with the same texture is a miss. review.py shows the rubric to
# the human reviewer, and generate.py's LLM rewrite pass gets it too so it
# diverges prompts along axes that actually matter for that style.
from dataclasses import dataclass


@dataclass(frozen=True)
class ArtStyle:
    art_style: str  # word_images.art_style value + candidates/{art_style}/ dir name
    label: str
    base_prompt: str
    rendering_variants: list[str]
    review_rubric: str


STYLES: dict[str, ArtStyle] = {
    "cartoon": ArtStyle(
        art_style="cartoon",
        label="Flat clip-art",
        base_prompt=(
            "flat vector clip-art illustration, simple flat shapes, bright "
            "solid colors, crisp and legible, children's-book educational "
            "illustration"
        ),
        rendering_variants=[
            "bold thick outlines with a playful sticker-like finish",
            "clean thin outlines with a crisp geometric-icon finish",
            "soft rounded shapes with a gentle storybook-illustration finish",
            "bold graphic shapes with a poster-illustration finish",
        ],
        review_rubric=(
            "Reject anything with photorealistic shading, gradients, or "
            "painterly/textured rendering. A good pick has bold flat "
            "colors, a clean readable silhouette, and no visual clutter - "
            "it should read clearly as an icon even at small size."
        ),
    ),
    # Deliberately describes the TECHNIQUE (hand-painted torn-tissue-paper
    # collage), not a specific author or book title - the look is a real,
    # nameable illustration technique on its own, and the prompt below never
    # invokes a living illustrator's name or a specific copyrighted work.
    "collage": ArtStyle(
        art_style="collage",
        label="Painted-paper collage",
        base_prompt=(
            "collage-style illustration made from hand-painted textured "
            "paper cut into organic torn-edge shapes, visible brushstroke "
            "texture and mottled paint patterns on each paper piece, "
            "layered overlapping shapes, thick simple silhouettes, bold "
            "saturated colors, a warm off-white textured-paper background, "
            "naive childlike composition, picture-book illustration for "
            "young children"
        ),
        rendering_variants=[
            "with visibly rough torn-paper edges and strong color contrast between layers",
            "with softer hand-cut edges and a slightly muted, sun-faded color palette",
            "with dense overlapping layers of small textured paper pieces building up the form",
            "with bold, minimal large paper shapes and lots of open background space",
        ],
        review_rubric=(
            "A good pick clearly reads as hand-made collage: visible paper "
            "texture, painterly mottling, torn or cut edges - not a smooth "
            "vector illustration. Reject anything airbrushed, glossy, or "
            "photorealistic, or anything where the paper texture "
            "disappeared into flat digital color."
        ),
    ),
    # The suggested third style: rooted in this project's own cultural
    # context (Yoruba/West African textile and folk-art traditions -
    # Adire resist-dye cloth, Aso-oke weave patterns) rather than a second
    # Western picture-book aesthetic. Describes a genre/tradition, not any
    # individual artist's copyrighted work.
    "textile": ArtStyle(
        art_style="textile",
        label="Folk-textile pattern",
        base_prompt=(
            "bold folk-art illustration inspired by West African textile "
            "patterns, made of flat geometric and organic shapes filled "
            "with warm earthy tones and vibrant accent colors, patterned "
            "textures reminiscent of adire and woven aso-oke cloth used as "
            "fill within the shapes, strong dark outlines, symmetrical and "
            "decorative, children's educational illustration"
        ),
        rendering_variants=[
            "with dense repeating geometric patterning across every shape",
            "with bold solid color blocks broken up by only a few small pattern accents",
            "with wavy organic resist-dye-style patterning",
            "with a warm sunset-toned earthy color palette and minimal patterning",
        ],
        review_rubric=(
            "A good pick uses flat bold shapes filled with visible "
            "textile-inspired patterning and a warm earthy-plus-vibrant "
            "palette. Reject anything that reads as generic Western "
            "clip-art (flat single-color fills, no pattern at all), "
            "anything that looks like a literal photographed fabric "
            "swatch rather than an illustration, and anything muddy, "
            "low-contrast, or where the pattern makes the subject "
            "unreadable."
        ),
    ),
}


def get(art_style: str) -> ArtStyle:
    try:
        return STYLES[art_style]
    except KeyError:
        available = ", ".join(sorted(STYLES))
        raise SystemExit(f'Unknown --art-style "{art_style}". Available: {available}') from None

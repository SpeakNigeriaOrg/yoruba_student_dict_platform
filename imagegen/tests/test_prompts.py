import unittest

from imagegen.prompts import WHITE_EUROPEAN_DESCRIPTOR, build_variant_prompts
from imagegen.styles import STYLES

CARTOON = STYLES["cartoon"]


class BuildVariantPromptsTest(unittest.TestCase):
    def test_count_matches_request(self):
        prompts = build_variant_prompts(CARTOON, "a dog", "aja", 4)
        self.assertEqual(len(prompts), 4)

    def test_variants_are_not_all_identical(self):
        # With 4 variants sampled without replacement from >=3-option slot
        # lists, at least two of the four should differ - a regression here
        # would mean the sampler collapsed to always picking the same slot.
        prompts = build_variant_prompts(CARTOON, "a dog", "aja", 4)
        self.assertGreater(len(set(prompts)), 1)

    def test_more_variants_than_slot_options_still_returns_requested_count(self):
        # HUMAN_DESCRIPTORS/COMPOSITIONS/etc. all have fewer than 8 options -
        # this exercises the cycle-with-a-fresh-shuffle path.
        prompts = build_variant_prompts(CARTOON, "a dog", "aja", 8)
        self.assertEqual(len(prompts), 8)

    def test_falls_back_to_display_text_when_no_definition(self):
        prompts = build_variant_prompts(CARTOON, None, "aja", 1)
        self.assertIn("aja", prompts[0])

    def test_white_european_descriptor_has_no_contradictory_contrast_clause(self):
        # Regression test: the "rather than defaulting to a white Western
        # appearance" framing must never appear alongside the descriptor it
        # contrasts against - that reads as self-contradictory.
        found_white_european = False
        for _ in range(50):  # random sampling - loop until we see the case
            for prompt in build_variant_prompts(CARTOON, "a dog", "aja", 6):
                if WHITE_EUROPEAN_DESCRIPTOR in prompt:
                    found_white_european = True
                    self.assertNotIn("rather than defaulting", prompt)
        self.assertTrue(found_white_european, "test never sampled the white European descriptor")

    def test_every_registered_style_produces_prompts_containing_its_base_prompt(self):
        # Each style's own base_prompt/rendering_variants must actually make
        # it into the generated text - a style whose look never reaches the
        # model would silently generate as some other (or no) style.
        for style in STYLES.values():
            prompts = build_variant_prompts(style, "a dog", "aja", 4)
            for prompt in prompts:
                self.assertIn(style.base_prompt, prompt)

    def test_different_styles_produce_different_prompts_for_the_same_concept(self):
        cartoon_prompts = build_variant_prompts(STYLES["cartoon"], "a dog", "aja", 1)
        collage_prompts = build_variant_prompts(STYLES["collage"], "a dog", "aja", 1)
        self.assertNotEqual(cartoon_prompts, collage_prompts)


if __name__ == "__main__":
    unittest.main()

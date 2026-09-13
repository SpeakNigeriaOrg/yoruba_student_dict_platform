import unittest

from imagegen.prompts import (
    WHITE_EUROPEAN_DESCRIPTOR,
    _mentions_person,
    build_variant_drafts,
    build_variant_prompts,
    compose,
)
from imagegen.styles import STYLES

CARTOON = STYLES["cartoon"]


class MentionsPersonTest(unittest.TestCase):
    def test_object_definitions_are_not_flagged(self):
        # The abo_plate ("plate/bowl") smoke test that motivated this whole
        # module: a plain object definition must never be treated as human.
        self.assertFalse(_mentions_person("Bowl, plate. Typically plastic, enamel, metal, or wood.", "abo"))
        self.assertFalse(_mentions_person("a small barking domestic animal", "aja"))

    def test_person_definitions_are_flagged(self):
        self.assertTrue(_mentions_person("A person who teaches children.", "olukọ"))
        self.assertTrue(_mentions_person("One's mother.", "iya"))
        self.assertTrue(_mentions_person("A young boy.", "omokunrin"))

    def test_matches_are_whole_words_not_substrings(self):
        # "he"/"her" etc. are common substrings ("shed", "there") - the
        # pattern must not fire on those.
        self.assertFalse(_mentions_person("A wooden shed for storing tools.", "abà"))


class BuildVariantDraftsTest(unittest.TestCase):
    def test_count_matches_request(self):
        drafts = build_variant_drafts(CARTOON, "a dog", "aja", 4)
        self.assertEqual(len(drafts), 4)

    def test_object_concept_never_gets_a_human_clause(self):
        # Regression test for the abo_plate failure: build_variant_drafts
        # must never attach a human-descriptor clause to a non-person
        # concept, in any of many draws (not just "usually").
        definition = "Bowl, plate. Typically plastic, enamel, metal, or wood."
        for _ in range(20):
            for visual, clause in build_variant_drafts(CARTOON, definition, "abo", 4):
                self.assertEqual(clause, "")
                self.assertNotIn("person", visual)

    def test_person_concept_gets_a_direct_not_conditional_clause(self):
        # The old design hedged with "if the illustration depicts a human
        # being" on every prompt; that's exactly what a diffusion model
        # can't reliably honor, and what the LLM rewrite flattened into an
        # assertion. Once we've decided a word IS about a person, the
        # clause should already be a direct instruction, not a hedge.
        found_any = False
        for _ in range(20):
            for _visual, clause in build_variant_drafts(CARTOON, "A person who teaches children.", "olukọ", 4):
                self.assertNotEqual(clause, "")
                self.assertNotIn("if the illustration", clause.lower())
                found_any = True
        self.assertTrue(found_any)

    def test_white_european_descriptor_clause_has_no_self_contradiction(self):
        found_white_european = False
        for _ in range(50):
            for _visual, clause in build_variant_drafts(CARTOON, "A person who teaches children.", "olukọ", 6):
                if WHITE_EUROPEAN_DESCRIPTOR in clause:
                    found_white_european = True
                    self.assertNotIn("not a white Western appearance", clause)
        self.assertTrue(found_white_european, "test never sampled the white European descriptor")

    def test_more_variants_than_slot_options_still_returns_requested_count(self):
        drafts = build_variant_drafts(CARTOON, "A person who teaches children.", "olukọ", 8)
        self.assertEqual(len(drafts), 8)


class BuildVariantPromptsTest(unittest.TestCase):
    def test_count_matches_request(self):
        prompts = build_variant_prompts(CARTOON, "a dog", "aja", 4)
        self.assertEqual(len(prompts), 4)

    def test_variants_are_not_all_identical(self):
        prompts = build_variant_prompts(CARTOON, "a dog", "aja", 4)
        self.assertGreater(len(set(prompts)), 1)

    def test_falls_back_to_display_text_when_no_definition(self):
        prompts = build_variant_prompts(CARTOON, None, "aja", 1)
        self.assertIn("aja", prompts[0])

    def test_every_registered_style_produces_prompts_containing_its_base_prompt(self):
        for style in STYLES.values():
            prompts = build_variant_prompts(style, "a dog", "aja", 4)
            for prompt in prompts:
                self.assertIn(style.base_prompt, prompt)

    def test_different_styles_produce_different_prompts_for_the_same_concept(self):
        cartoon_prompts = build_variant_prompts(STYLES["cartoon"], "a dog", "aja", 1)
        collage_prompts = build_variant_prompts(STYLES["collage"], "a dog", "aja", 1)
        self.assertNotEqual(cartoon_prompts, collage_prompts)

    def test_compose_matches_manual_join(self):
        self.assertEqual(compose("A picture of a dog.", "Depict a person."), "A picture of a dog. Depict a person.")
        self.assertEqual(compose("A picture of a dog.", ""), "A picture of a dog.")


if __name__ == "__main__":
    unittest.main()

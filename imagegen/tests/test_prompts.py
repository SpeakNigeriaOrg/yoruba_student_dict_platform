import unittest

from imagegen.prompts import (
    WHITE_EUROPEAN_DESCRIPTOR,
    build_variant_drafts,
    build_variant_prompts,
    compose,
)
from imagegen.styles import STYLES

CARTOON = STYLES["cartoon"]

# There used to be a MentionsPersonTest here, covering a keyword heuristic
# that guessed whether a concept depicted a human being from its dictionary
# gloss. It was deleted along with the heuristic itself: it false-positived
# on "you" (gloss: "...second-person singular... pronoun" - "person" there
# is grammar jargon, not a depicted human), and a hand-written word list
# will always have another case like that. The real fix was asking the LLM
# per word instead (illustration_brief in prompts.py) - see
# BuildVariantDraftsTest below, which now takes involves_person as a plain
# bool input rather than computing it from a heuristic.


class BuildVariantDraftsTest(unittest.TestCase):
    def test_count_matches_request(self):
        drafts = build_variant_drafts(CARTOON, "a dog", 4, involves_person=False)
        self.assertEqual(len(drafts), 4)

    def test_object_concept_never_gets_a_human_clause(self):
        for _ in range(20):
            for visual, clause in build_variant_drafts(CARTOON, "a bowl or plate", 4, involves_person=False):
                self.assertEqual(clause, "")
                self.assertNotIn("person", visual)

    def test_person_concept_gets_a_direct_not_conditional_clause(self):
        # The old design hedged with "if the illustration depicts a human
        # being" on every prompt; that's exactly what a diffusion model
        # can't reliably honor, and what the LLM rewrite flattened into an
        # assertion. Once a word IS known to be about a person, the clause
        # should already be a direct instruction, not a hedge.
        found_any = False
        for _ in range(20):
            for _visual, clause in build_variant_drafts(CARTOON, "a person teaching children", 4, involves_person=True):
                self.assertNotEqual(clause, "")
                self.assertNotIn("if the illustration", clause.lower())
                found_any = True
        self.assertTrue(found_any)

    def test_white_european_descriptor_clause_has_no_self_contradiction(self):
        found_white_european = False
        for _ in range(50):
            for _visual, clause in build_variant_drafts(CARTOON, "a person teaching children", 6, involves_person=True):
                if WHITE_EUROPEAN_DESCRIPTOR in clause:
                    found_white_european = True
                    self.assertNotIn("not a white Western appearance", clause)
        self.assertTrue(found_white_european, "test never sampled the white European descriptor")

    def test_more_variants_than_slot_options_still_returns_requested_count(self):
        drafts = build_variant_drafts(CARTOON, "a person teaching children", 8, involves_person=True)
        self.assertEqual(len(drafts), 8)


class BuildVariantPromptsTest(unittest.TestCase):
    def test_count_matches_request(self):
        prompts = build_variant_prompts(CARTOON, "a dog", 4, involves_person=False)
        self.assertEqual(len(prompts), 4)

    def test_variants_are_not_all_identical(self):
        prompts = build_variant_prompts(CARTOON, "a dog", 4, involves_person=False)
        self.assertGreater(len(set(prompts)), 1)

    def test_every_registered_style_produces_prompts_containing_its_base_prompt(self):
        for style in STYLES.values():
            prompts = build_variant_prompts(style, "a dog", 4, involves_person=False)
            for prompt in prompts:
                self.assertIn(style.base_prompt, prompt)

    def test_different_styles_produce_different_prompts_for_the_same_concept(self):
        cartoon_prompts = build_variant_prompts(STYLES["cartoon"], "a dog", 1, involves_person=False)
        collage_prompts = build_variant_prompts(STYLES["collage"], "a dog", 1, involves_person=False)
        self.assertNotEqual(cartoon_prompts, collage_prompts)

    def test_compose_matches_manual_join(self):
        self.assertEqual(compose("A picture of a dog.", "Depict a person."), "A picture of a dog. Depict a person.")
        self.assertEqual(compose("A picture of a dog.", ""), "A picture of a dog.")


if __name__ == "__main__":
    unittest.main()

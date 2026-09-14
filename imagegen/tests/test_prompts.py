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

# There used to be a MentionsPersonTest here scanning raw dictionary
# glosses, deleted after it false-positived on "you" (gloss: "...second-
# person singular... pronoun" - "person" there is grammar jargon). It's
# back, in a different shape: _mentions_person now scans concrete scene
# text illustration_scenes writes (or, in --no-llm mode, a plain gloss),
# and is checked PER VARIANT rather than once for a whole word - see
# MentionsPersonTest and test_each_variant_gets_its_own_human_clause_decision
# below. This replaced a separate LLM self-report (a "PERSON: yes/no" field)
# that turned out wrong more than half the time even against its own scene
# text - see prompts.py's module docstring, "Round 4".


class MentionsPersonTest(unittest.TestCase):
    def test_object_scene_is_not_flagged(self):
        self.assertFalse(_mentions_person("A stack of ten books on a table."))

    def test_person_scene_is_flagged(self):
        self.assertTrue(_mentions_person("A man and a child walking hand in hand."))
        self.assertTrue(_mentions_person("A person counting ten fingers."))

    def test_matches_are_whole_words_not_substrings(self):
        # "he"/"her" etc. are common substrings ("shed", "there") - the
        # pattern must not fire on those.
        self.assertFalse(_mentions_person("A wooden shed for storing tools."))


class BuildVariantDraftsTest(unittest.TestCase):
    def test_count_matches_request(self):
        drafts = build_variant_drafts(CARTOON, ["a dog"] * 4, 4)
        self.assertEqual(len(drafts), 4)

    def test_rejects_a_concepts_list_of_the_wrong_length(self):
        with self.assertRaises(ValueError):
            build_variant_drafts(CARTOON, ["a dog"] * 3, 4)

    def test_each_variant_uses_its_own_concept(self):
        # illustration_scenes gives each variant a DIFFERENT concrete scene
        # when the concept calls for it (e.g. "a soccer ball" / "a
        # basketball" / ... for the category "ball") - this is exactly what
        # a shared single concept string couldn't do, and what motivated
        # switching build_variant_drafts to take one concept per variant.
        concepts = ["a soccer ball", "a basketball", "a beach ball", "a tennis ball"]
        drafts = build_variant_drafts(CARTOON, concepts, 4)
        for concept, (visual, _clause) in zip(concepts, drafts):
            self.assertIn(concept, visual)

    def test_object_concept_never_gets_a_human_clause(self):
        for _ in range(20):
            for visual, clause in build_variant_drafts(CARTOON, ["a bowl or plate"] * 4, 4):
                self.assertEqual(clause, "")
                self.assertNotIn("person", visual)

    def test_each_variant_gets_its_own_human_clause_decision(self):
        # Regression test for the "ogun" ("twenty") case: a word's scenes
        # can mix human and non-human subjects in the SAME batch (a stack
        # of ten books alongside a person counting fingers). Only the
        # variants whose own concept text mentions a person should get a
        # descriptor clause - a single whole-batch flag can't express this.
        concepts = ["a stack of ten books", "a person counting ten fingers", "a row of ten candles", "a child holding up ten fingers"]
        drafts = build_variant_drafts(CARTOON, concepts, 4)
        self.assertEqual(drafts[0][1], "")  # books
        self.assertNotEqual(drafts[1][1], "")  # person
        self.assertEqual(drafts[2][1], "")  # candles
        self.assertNotEqual(drafts[3][1], "")  # child

    def test_person_concept_gets_a_direct_not_conditional_clause(self):
        # The old design hedged with "if the illustration depicts a human
        # being" on every prompt; that's exactly what a diffusion model
        # can't reliably honor, and what an even older rewrite pass
        # flattened into an assertion. Once a concept's own text describes
        # a person, the clause should already be a direct instruction, not
        # a hedge.
        found_any = False
        concepts = ["a person teaching children"] * 4
        for _ in range(20):
            for _visual, clause in build_variant_drafts(CARTOON, concepts, 4):
                self.assertNotEqual(clause, "")
                self.assertNotIn("if the illustration", clause.lower())
                found_any = True
        self.assertTrue(found_any)

    def test_white_european_descriptor_clause_has_no_self_contradiction(self):
        found_white_european = False
        concepts = ["a person teaching children"] * 6
        for _ in range(50):
            for _visual, clause in build_variant_drafts(CARTOON, concepts, 6):
                if WHITE_EUROPEAN_DESCRIPTOR in clause:
                    found_white_european = True
                    self.assertNotIn("not a white Western appearance", clause)
        self.assertTrue(found_white_european, "test never sampled the white European descriptor")

    def test_more_variants_than_slot_options_still_returns_requested_count(self):
        drafts = build_variant_drafts(CARTOON, ["a person teaching children"] * 8, 8)
        self.assertEqual(len(drafts), 8)


class BuildVariantPromptsTest(unittest.TestCase):
    def test_count_matches_request(self):
        prompts = build_variant_prompts(CARTOON, ["a dog"] * 4, 4)
        self.assertEqual(len(prompts), 4)

    def test_variants_are_not_all_identical(self):
        prompts = build_variant_prompts(CARTOON, ["a dog"] * 4, 4)
        self.assertGreater(len(set(prompts)), 1)

    def test_every_registered_style_produces_prompts_containing_its_base_prompt(self):
        for style in STYLES.values():
            prompts = build_variant_prompts(style, ["a dog"] * 4, 4)
            for prompt in prompts:
                self.assertIn(style.base_prompt, prompt)

    def test_different_styles_produce_different_prompts_for_the_same_concept(self):
        cartoon_prompts = build_variant_prompts(STYLES["cartoon"], ["a dog"], 1)
        collage_prompts = build_variant_prompts(STYLES["collage"], ["a dog"], 1)
        self.assertNotEqual(cartoon_prompts, collage_prompts)

    def test_compose_matches_manual_join(self):
        self.assertEqual(compose("A picture of a dog.", "Depict a person."), "A picture of a dog. Depict a person.")
        self.assertEqual(compose("A picture of a dog.", ""), "A picture of a dog.")


if __name__ == "__main__":
    unittest.main()

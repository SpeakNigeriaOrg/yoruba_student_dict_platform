import unittest

from imagegen.prompts import (
    WHITE_EUROPEAN_DESCRIPTOR,
    _mentions_person,
    attach_human_clauses,
    build_variant_prompts,
    build_variant_visuals,
    compose,
)
from imagegen.styles import STYLES

CARTOON = STYLES["cartoon"]

# There used to be a MentionsPersonTest here scanning raw dictionary
# glosses, deleted after it false-positived on "you" (gloss: "...second-
# person singular... pronoun" - "person" there is grammar jargon). It's
# back, in a different shape: _mentions_person now scans concrete scene
# text illustration_scenes writes (or, in --no-llm mode, a plain gloss),
# and is checked PER VARIANT rather than once for a whole word. This
# replaced a separate LLM self-report (a "PERSON: yes/no" field) that
# turned out wrong more than half the time even against its own scene
# text - see prompts.py's module docstring, "Round 4". Round 5 then found
# the clause decision itself was running at the wrong TIME (before
# LocalLLMRewriter.rewrite_batch, not after) - see AttachHumanClausesTest
# below, which is why build_variant_visuals (mechanical only) and
# attach_human_clauses (the decision) are now two separate functions
# instead of one.


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

    def test_plural_forms_are_matched(self):
        # Regression test: the word list originally only had singular
        # forms, so "Friends sitting on a park bench" and "Soldiers
        # saluting" - both unambiguously human - matched nothing at all.
        self.assertTrue(_mentions_person("Friends sitting on a park bench."))
        self.assertTrue(_mentions_person("Soldiers saluting in formation."))
        self.assertTrue(_mentions_person("A family of four embracing."))
        self.assertTrue(_mentions_person("A choir of singers looking at each other."))

    def test_plural_pronouns_do_not_false_positive_on_non_human_antecedents(self):
        # Regression test: "they"/"them"/"their" refer back to whatever
        # was just mentioned, human or not - this exact sentence (a real
        # generated scene) was wrongly flagged human before they/them/their
        # were dropped from the word list, because of "them" alone.
        self.assertFalse(_mentions_person("A group of ten birds flying with one more bird joining them."))

    def test_singular_gendered_pronouns_are_still_matched(self):
        # Unlike "they"/"them", "he"/"she"/etc. essentially never refer to
        # an object or animal in this kind of scene text, so they stayed.
        self.assertTrue(_mentions_person("A person adjusting his hat before leaving."))


class BuildVariantVisualsTest(unittest.TestCase):
    def test_count_matches_request(self):
        visuals = build_variant_visuals(CARTOON, ["a dog"] * 4, 4)
        self.assertEqual(len(visuals), 4)

    def test_rejects_a_concepts_list_of_the_wrong_length(self):
        with self.assertRaises(ValueError):
            build_variant_visuals(CARTOON, ["a dog"] * 3, 4)

    def test_each_variant_uses_its_own_concept(self):
        # illustration_scenes gives each variant a DIFFERENT concrete scene
        # when the concept calls for it (e.g. "a soccer ball" / "a
        # basketball" / ... for the category "ball") - this is exactly what
        # a shared single concept string couldn't do.
        concepts = ["a soccer ball", "a basketball", "a beach ball", "a tennis ball"]
        visuals = build_variant_visuals(CARTOON, concepts, 4)
        for concept, visual in zip(concepts, visuals):
            self.assertIn(concept, visual)

    def test_more_variants_than_slot_options_still_returns_requested_count(self):
        visuals = build_variant_visuals(CARTOON, ["a person teaching children"] * 8, 8)
        self.assertEqual(len(visuals), 8)

    def test_never_attaches_a_human_clause_itself(self):
        # build_variant_visuals is purely mechanical now - even an
        # obviously human concept must come back with no "Depict" clause;
        # that's attach_human_clauses's job, called separately (and,
        # crucially, on the FINAL text - see AttachHumanClausesTest).
        visuals = build_variant_visuals(CARTOON, ["a person teaching children"] * 4, 4)
        for visual in visuals:
            self.assertNotIn("Depict", visual)


class AttachHumanClausesTest(unittest.TestCase):
    def test_object_concept_never_gets_a_human_clause(self):
        for _ in range(20):
            for visual, clause in attach_human_clauses(["a bowl or plate"] * 4):
                self.assertEqual(clause, "")

    def test_each_variant_gets_its_own_human_clause_decision(self):
        # Regression test for the "ogun" ("twenty") case: a word's scenes
        # can mix human and non-human subjects in the SAME batch (a stack
        # of ten books alongside a person counting fingers). Only the
        # variants whose own text mentions a person should get a
        # descriptor clause - a single whole-batch flag can't express this.
        visuals = ["a stack of ten books", "a person counting ten fingers", "a row of ten candles", "a child holding up ten fingers"]
        pairs = attach_human_clauses(visuals)
        self.assertEqual(pairs[0][1], "")  # books
        self.assertNotEqual(pairs[1][1], "")  # person
        self.assertEqual(pairs[2][1], "")  # candles
        self.assertNotEqual(pairs[3][1], "")  # child

    def test_decides_from_whatever_text_it_is_actually_given(self):
        # Regression test ("Round 5"): an earlier version decided the
        # clause from the pre-rewrite concept and carried it through
        # rewriting unchanged. A live run showed rewriting can introduce a
        # person that wasn't in the original text ("a box with earphones"
        # -> "a person listening to a box with earphones"), which the
        # pre-rewrite decision never saw. The fix is calling
        # attach_human_clauses on the LAST text before image generation -
        # this test just confirms it decides fresh from whatever list it's
        # handed, with no memory of anything upstream.
        pairs = attach_human_clauses(["a box with earphones playing music"])
        self.assertEqual(pairs[0][1], "")
        pairs = attach_human_clauses(["a person listening to a box with earphones"])
        self.assertNotEqual(pairs[0][1], "")

    def test_person_concept_gets_a_direct_not_conditional_clause(self):
        # The old design hedged with "if the illustration depicts a human
        # being" on every prompt; that's exactly what a diffusion model
        # can't reliably honor, and what an even older rewrite pass
        # flattened into an assertion. Once a concept's own text describes
        # a person, the clause should already be a direct instruction, not
        # a hedge.
        found_any = False
        for _ in range(20):
            for _visual, clause in attach_human_clauses(["a person teaching children"] * 4):
                self.assertNotEqual(clause, "")
                self.assertNotIn("if the illustration", clause.lower())
                found_any = True
        self.assertTrue(found_any)

    def test_white_european_descriptor_clause_has_no_self_contradiction(self):
        found_white_european = False
        for _ in range(50):
            for _visual, clause in attach_human_clauses(["a person teaching children"] * 6):
                if WHITE_EUROPEAN_DESCRIPTOR in clause:
                    found_white_european = True
                    self.assertNotIn("not a white Western appearance", clause)
        self.assertTrue(found_white_european, "test never sampled the white European descriptor")

    def test_more_variants_than_slot_options_still_returns_requested_count(self):
        pairs = attach_human_clauses(["a person teaching children"] * 8)
        self.assertEqual(len(pairs), 8)


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

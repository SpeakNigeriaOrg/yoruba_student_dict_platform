import unittest

from imagegen.generate import effective_gloss


class EffectiveGlossTest(unittest.TestCase):
    def test_uses_the_real_definition_when_present(self):
        word = {"word_id": "irawo_star", "display_text": "ìràwọ̀", "definition": "star, celestial object"}
        self.assertEqual(effective_gloss(word), "star, celestial object")

    def test_derives_a_gloss_from_word_id_when_definition_is_null(self):
        # Regression test: a real full run sent the LLM "Gloss: (no
        # definition)" for these words (18 of 185 golden_record rows have
        # definition = NULL) - "radio" hallucinated into a fruit, "leave
        # it" into an unrelated bird/butterfly/spider nature scene. word_id
        # already encodes the gloss as a suffix; display_text's word count
        # says where the Yoruba part of word_id ends.
        cases = [
            ({"word_id": "redio_radio", "display_text": "rédíò", "definition": None}, "radio"),
            ({"word_id": "fi_sile_leave_it", "display_text": "fi sílẹ̀", "definition": None}, "leave it"),
            ({"word_id": "fun_mi_give_me", "display_text": "fún mi", "definition": None}, "give me"),
            ({"word_id": "ma_se_bee_stop_that", "display_text": "má ṣe bẹ́ẹ̀", "definition": None}, "stop that"),
        ]
        for word, expected in cases:
            self.assertEqual(effective_gloss(word), expected)

    def test_falls_back_to_display_text_if_word_id_has_nothing_past_the_yoruba_part(self):
        word = {"word_id": "aja", "display_text": "aja", "definition": None}
        self.assertEqual(effective_gloss(word), "aja")


if __name__ == "__main__":
    unittest.main()

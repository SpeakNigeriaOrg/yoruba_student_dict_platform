import unittest

from videogen.prompts import compose_minimax_prompt


class ComposeMinimaxPromptTest(unittest.TestCase):
    # compose_minimax_prompt is the mechanical half of "Round 8" (see
    # prompts.py's docstring) - the LLM decides motion/sound content,
    # this function is only responsible for shaping that content into
    # MiniMax H3's own documented three-field rewrite format. These tests
    # cover the shape, not the LLM's judgment.

    def test_wraps_still_frame_in_a_single_untimed_shot_one_block(self):
        prompt = compose_minimax_prompt("A dog crouching, flat cartoon style.", "it wags its tail once.", "a soft pant.")
        self.assertIn("integrated_multimodal_description: [Shot 1] A dog crouching, flat cartoon style. it wags its tail once.", prompt)

    def test_all_three_fields_present_in_order(self):
        prompt = compose_minimax_prompt("A dog.", "it sits.", "a quiet breath.")
        lines = prompt.splitlines()
        self.assertTrue(lines[0].startswith("integrated_multimodal_description:"))
        self.assertTrue(lines[1].startswith("overall_soundscape:"))
        self.assertTrue(lines[2].startswith("non_diegetic_music:"))

    def test_non_diegetic_music_is_always_n_a(self):
        # Hardcoded, never decided by the LLM - see the function's own
        # docstring for why: these are silent flashcard illustrations,
        # not narrative video, so there is no case where background
        # score is the right answer.
        prompt = compose_minimax_prompt("A dog.", "it sits.", "a quiet breath.")
        self.assertIn("non_diegetic_music: N/A", prompt)

    def test_blank_sound_clause_becomes_n_a(self):
        prompt = compose_minimax_prompt("A dog.", "it sits.", "   ")
        self.assertIn("overall_soundscape: N/A", prompt)

    def test_literal_n_a_sound_clause_passes_through(self):
        prompt = compose_minimax_prompt("A dog.", "it sits.", "N/A")
        self.assertIn("overall_soundscape: N/A", prompt)


if __name__ == "__main__":
    unittest.main()

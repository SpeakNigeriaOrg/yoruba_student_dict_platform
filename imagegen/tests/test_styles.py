import unittest

from imagegen.styles import STYLES, get


class StylesTest(unittest.TestCase):
    def test_every_style_has_the_fields_prompts_py_and_review_py_rely_on(self):
        for art_style, style in STYLES.items():
            self.assertEqual(style.art_style, art_style)
            self.assertTrue(style.label)
            self.assertTrue(style.base_prompt)
            self.assertTrue(style.review_rubric)
            self.assertGreaterEqual(len(style.rendering_variants), 2)

    def test_get_returns_the_matching_style(self):
        self.assertIs(get("cartoon"), STYLES["cartoon"])

    def test_get_raises_a_clear_error_for_an_unknown_style(self):
        with self.assertRaises(SystemExit):
            get("not-a-real-style")


if __name__ == "__main__":
    unittest.main()

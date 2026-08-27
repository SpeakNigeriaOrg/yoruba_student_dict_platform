import json
from pathlib import Path
import tempfile
import unittest

from tone_lab.legacy.staged_corpus import discover


class LegacyStagedCorpusTests(unittest.TestCase):
    def test_word_is_exact_but_syllable_origin_remains_ambiguous(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "public").mkdir()
            (root / "content/staged/words/speaker1").mkdir(parents=True)
            (root / "content/staged/syllables/speaker1").mkdir(parents=True)
            (root / "content/staged/words/speaker1/owo_hand.wav").touch()
            (root / "content/staged/syllables/speaker1/wo_low.wav").touch()
            (root / "public/vocab.json").write_text(json.dumps({
                "owo_hand": {"displayText": "ọwọ", "syllables": ["ọ", "wọ̀"]}
            }))
            (root / "public/syllables.json").write_text(json.dumps({
                "speaker1": {"wọ̀": {"audio": "syllables/speaker1/wo_low.wav", "tone": "low"}}
            }))

            records = list(discover(root))
            word = next(record for record in records if record.recording_style == "natural_word")
            syllable = next(record for record in records if record.recording_style == "careful_syllable")
            self.assertEqual(word.provenance_status, "exact")
            self.assertEqual(word.expected_syllables, ("ọ", "wọ̀"))
            self.assertEqual(syllable.syllable_text_candidates, ("wọ̀",))
            self.assertEqual(syllable.intended_tone, "low")
            self.assertEqual(syllable.provenance_status, "ambiguous_origin")
            self.assertIsNone(syllable.word_id)


if __name__ == "__main__":
    unittest.main()

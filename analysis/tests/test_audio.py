import math
import unittest

from tone_lab.audio import PROFILES, measure, prepare


RATE = 8_000


def tone(duration_s, amplitude=0.2, frequency=220):
    return [amplitude * math.sin(2 * math.pi * frequency * i / RATE) for i in range(round(duration_s * RATE))]


class AudioPreparationTests(unittest.TestCase):
    def test_trims_silence_but_keeps_configured_context(self):
        samples = [0.0] * RATE + tone(0.5) + [0.0] * RATE
        result = prepare(samples, RATE, PROFILES["game-word"])
        self.assertGreater(result.cut_start_sample, round(0.85 * RATE))
        self.assertLess(result.cut_start_sample, RATE)
        self.assertGreater(result.cut_end_sample, round(1.5 * RATE))
        self.assertLess(result.cut_end_sample, round(1.65 * RATE))
        self.assertNotIn("trim_abstained_no_reliable_activity", result.flags)

    def test_bridges_short_internal_gap(self):
        samples = [0.0] * 800 + tone(0.2) + [0.0] * 400 + tone(0.2) + [0.0] * 800
        result = prepare(samples, RATE, PROFILES["game-word"])
        self.assertGreater(result.detected_end_sample - result.detected_start_sample, round(0.4 * RATE))

    def test_silence_abstains_instead_of_trimming_to_nothing(self):
        samples = [0.0] * RATE
        result = prepare(samples, RATE, PROFILES["game-word"])
        self.assertIn("trim_abstained_no_reliable_activity", result.flags)
        self.assertEqual(result.cut_start_sample, 0)
        self.assertEqual(result.cut_end_sample, len(samples))

    def test_gain_hits_rms_target_without_crossing_peak_ceiling(self):
        samples = [0.0] * 800 + tone(0.5, amplitude=0.02) + [0.0] * 800
        result = prepare(samples, RATE, PROFILES["game-word"])
        self.assertLessEqual(result.applied_gain_db, PROFILES["game-word"].max_gain_db)
        self.assertLessEqual(result.after.sample_peak_dbfs, PROFILES["game-word"].peak_ceiling_dbfs + 0.01)

    def test_flags_clipped_input(self):
        result = prepare([0.0] * 800 + [1.0] * 800 + [0.0] * 800, RATE, PROFILES["game-word"])
        self.assertIn("source_sample_clipping", result.flags)

    def test_measurement_reports_dc_offset(self):
        metrics = measure([0.1] * RATE, RATE)
        self.assertAlmostEqual(metrics.dc_offset, 0.1)
        self.assertAlmostEqual(metrics.duration_s, 1.0)


if __name__ == "__main__":
    unittest.main()

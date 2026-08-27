import math
import unittest

from tone_lab.intervals import acoustic_tone_bearing_interval, central_interval


RATE = 8_000


class ToneBearingIntervalTests(unittest.TestCase):
    def test_central_baseline_is_exact(self):
        interval = central_interval([0.0] * 1000)
        self.assertEqual((interval.start_sample, interval.end_sample), (200, 800))

    def test_acoustic_detector_finds_central_voiced_region(self):
        silence = [0.0] * 1600
        voiced = [0.2 * math.sin(2 * math.pi * 180 * i / RATE) for i in range(2400)]
        interval = acoustic_tone_bearing_interval(silence + voiced + silence, RATE)
        self.assertIsNotNone(interval)
        self.assertGreater(interval.start_sample, 1400)
        self.assertLess(interval.start_sample, 1900)
        self.assertGreater(interval.end_sample, 3700)
        self.assertLess(interval.end_sample, 4200)

    def test_acoustic_detector_abstains_on_silence(self):
        self.assertIsNone(acoustic_tone_bearing_interval([0.0] * RATE, RATE))


if __name__ == "__main__":
    unittest.main()

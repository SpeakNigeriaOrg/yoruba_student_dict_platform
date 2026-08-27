import math
import unittest

from tone_lab.alignment import align_syllable_templates


RATE = 8_000


def tone(frequency, duration=.25):
    return [0.2 * math.sin(2 * math.pi * frequency * i / RATE) for i in range(round(duration * RATE))]


class AlignmentTests(unittest.TestCase):
    def test_ordered_templates_partition_natural_word(self):
        first = tone(140)
        second = tone(240)
        natural = first + second
        intervals, cost = align_syllable_templates(natural, [first, second], RATE)
        self.assertEqual(len(intervals), 2)
        self.assertLess(intervals[0].start_sample, 200)
        self.assertGreater(intervals[0].end_sample, 1500)
        self.assertLess(intervals[1].start_sample, 2500)
        self.assertGreater(intervals[1].end_sample, 3600)
        self.assertLess(cost, 1.0)


if __name__ == "__main__":
    unittest.main()

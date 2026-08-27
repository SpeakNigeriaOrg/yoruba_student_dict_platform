"""Locate the voiced tone-bearing portion of an isolated syllable.

The detector intentionally says tone-bearing rather than vowel: Yoruba syllabic nasals carry tone
but are not vowels. It uses only acoustic evidence and does not infer segment identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np
import parselmouth


DETECTOR = "praat_voicing_intensity/0.1.0"


@dataclass(frozen=True)
class ToneBearingInterval:
    start_sample: int
    end_sample: int
    source: str
    confidence: float
    flags: tuple


def central_interval(samples: Sequence[float], start_fraction: float = 0.2,
                     end_fraction: float = 0.8) -> ToneBearingInterval:
    if not 0 <= start_fraction < end_fraction <= 1:
        raise ValueError("central interval fractions must satisfy 0 <= start < end <= 1")
    return ToneBearingInterval(round(len(samples) * start_fraction), round(len(samples) * end_fraction),
                               "central_20_80", 0.0, ("baseline_not_acoustically_aligned",))


def acoustic_tone_bearing_interval(
    samples: Sequence[float], sample_rate: int, pitch_floor_hz: float = 60,
    pitch_ceiling_hz: float = 500, time_step_s: float = 0.005,
) -> Optional[ToneBearingInterval]:
    if len(samples) < round(0.06 * sample_rate):
        return None
    sound = parselmouth.Sound(np.asarray(samples, dtype=np.float64), sampling_frequency=sample_rate)
    effective_floor = max(pitch_floor_hz, 4.0 / sound.duration)
    if effective_floor >= pitch_ceiling_hz:
        return None
    try:
        pitch = sound.to_pitch_ac(
            time_step=time_step_s, pitch_floor=effective_floor, pitch_ceiling=pitch_ceiling_hz,
            very_accurate=True,
        )
    except parselmouth.PraatError:
        return None
    frequency = pitch.selected_array["frequency"]
    strength = pitch.selected_array["strength"]
    times = pitch.xs()
    intensity = sound.to_intensity(minimum_pitch=effective_floor, time_step=time_step_s)
    intensity_at_pitch = np.asarray([
        intensity.get_value(time) if intensity.xmin <= time <= intensity.xmax else np.nan
        for time in times
    ])
    finite_intensity = intensity_at_pitch[np.isfinite(intensity_at_pitch)]
    if not len(finite_intensity):
        return None
    intensity_floor = float(np.max(finite_intensity) - 25.0)
    active = (frequency > 0) & (strength >= 0.45) & (intensity_at_pitch >= intensity_floor)

    # Bridge pitch dropouts up to 30 ms, common around brief closures and irregular cycles.
    bridge_frames = round(0.03 / time_step_s)
    active = active.copy()
    true_indices = np.flatnonzero(active)
    for left, right in zip(true_indices, true_indices[1:]):
        if 1 < right - left <= bridge_frames + 1:
            active[left:right + 1] = True

    runs = []
    start = None
    for index, is_active in enumerate(active):
        if is_active and start is None:
            start = index
        elif not is_active and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, len(active) - 1))
    minimum_frames = max(3, round(0.06 / time_step_s))
    runs = [run for run in runs if run[1] - run[0] + 1 >= minimum_frames]
    if not runs:
        return None

    midpoint = sound.duration / 2
    # Prefer duration, with a modest centrality tie-breaker. This prevents a short voiced click at
    # an edge winning, without assuming that the nucleus itself must be perfectly centred.
    def score(run):
        first, last = run
        duration = (last - first + 1) * time_step_s
        centre = (times[first] + times[last]) / 2
        centrality = 1 - min(1, abs(centre - midpoint) / max(midpoint, 1e-6))
        return duration * (0.8 + 0.2 * centrality)

    first, last = max(runs, key=score)
    start_s = max(0, times[first] - time_step_s / 2)
    end_s = min(sound.duration, times[last] + time_step_s / 2)
    # Move 10 ms inward to reduce consonant-transition contamination, but only when enough of the
    # detected interval remains for stable F0 estimation.
    if end_s - start_s >= 0.10:
        start_s += 0.01
        end_s -= 0.01
    local_strength = strength[first:last + 1]
    coverage = float(np.mean(frequency[first:last + 1] > 0))
    duration_factor = min(1.0, (end_s - start_s) / 0.15)
    confidence = max(0.0, min(1.0, coverage * float(np.median(local_strength)) * duration_factor))
    flags = []
    if confidence < 0.5:
        flags.append("low_interval_confidence")
    return ToneBearingInterval(
        max(0, round(start_s * sample_rate)), min(len(samples), round(end_s * sample_rate)),
        DETECTOR, confidence, tuple(flags),
    )

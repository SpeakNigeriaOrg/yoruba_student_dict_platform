"""Pitch extraction from raw waveform samples using Praat's autocorrelation method."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Optional, Sequence, Tuple

import numpy as np
import parselmouth


EXTRACTOR = "praat_ac/0.1.0"


@dataclass(frozen=True)
class PitchFeatures:
    median_hz: Optional[float]
    q25_hz: Optional[float]
    q75_hz: Optional[float]
    start_hz: Optional[float]
    end_hz: Optional[float]
    slope_semitones: Optional[float]
    voiced_fraction: float
    contour_hz: Tuple[Optional[float], ...]
    flags: Tuple[str, ...]


def extract_pitch(
    samples: Sequence[float], sample_rate: int, pitch_floor_hz: float = 60,
    pitch_ceiling_hz: float = 500, contour_points: int = 9,
) -> PitchFeatures:
    if not samples:
        raise ValueError("cannot extract pitch from empty audio")
    sound = parselmouth.Sound(np.asarray(samples, dtype=np.float64), sampling_frequency=sample_rate)
    # Praat's very-accurate autocorrelation window needs roughly six periods inside a signal.
    # Short aligned nuclei therefore require a higher floor than a whole clip.
    duration_floor = 6.1 / sound.duration
    effective_floor = max(pitch_floor_hz, duration_floor)
    if effective_floor >= pitch_ceiling_hz:
        return PitchFeatures(None, None, None, None, None, None, 0.0,
                             (None,) * contour_points, ("interval_too_short_for_pitch",))
    try:
        pitch = sound.to_pitch_ac(
            time_step=None, pitch_floor=effective_floor, pitch_ceiling=pitch_ceiling_hz,
            very_accurate=True,
        )
    except parselmouth.PraatError:
        return PitchFeatures(None, None, None, None, None, None, 0.0,
                             (None,) * contour_points, ("interval_too_short_for_pitch",))
    frequencies = pitch.selected_array["frequency"]
    voiced = frequencies[frequencies > 0]
    voiced_fraction = float(len(voiced) / len(frequencies)) if len(frequencies) else 0.0
    flags = []
    if voiced_fraction < 0.5:
        flags.append("low_voicing_coverage")
    if len(voiced) < 3:
        return PitchFeatures(None, None, None, None, None, None, voiced_fraction,
                             (None,) * contour_points, tuple(flags + ["insufficient_pitch_frames"]))

    duration = sound.duration
    # Avoid consonantal edges and interpolation outside the nearest voiced region. Each contour
    # value is the median of a local window, which is more robust than one instantaneous frame.
    centres = np.linspace(duration * 0.1, duration * 0.9, contour_points)
    half_window = max(0.015, duration / (contour_points * 3))
    times = pitch.xs()
    contour = []
    for centre in centres:
        local = frequencies[(times >= centre - half_window) & (times <= centre + half_window)]
        local = local[local > 0]
        contour.append(float(np.median(local)) if len(local) else None)
    present = [value for value in contour if value is not None]
    start = next((value for value in contour if value is not None), None)
    end = next((value for value in reversed(contour) if value is not None), None)
    slope = 12 * math.log2(end / start) if start and end else None
    return PitchFeatures(
        float(np.median(voiced)), float(np.quantile(voiced, 0.25)),
        float(np.quantile(voiced, 0.75)), start, end, slope, voiced_fraction,
        tuple(contour), tuple(flags),
    )

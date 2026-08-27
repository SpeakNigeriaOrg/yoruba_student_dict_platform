"""Dependency-light PCM WAV conditioning core.

This is deliberately usable without the eventual Praat/BS.1770 dependencies. It provides a
deterministic fallback and calls its level measurement RMS dBFS, never LUFS.
"""

from __future__ import annotations

from array import array
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import sys
import wave
from typing import List, Optional, Sequence, Tuple


PROCESSOR = "tone_lab.audio/0.1.0"


@dataclass(frozen=True)
class PreparationProfile:
    name: str
    frame_ms: float
    hop_ms: float
    threshold_above_noise_db: float
    release_below_threshold_db: float
    bridge_silence_ms: float
    min_active_ms: float
    leading_padding_ms: float
    trailing_padding_ms: float
    zero_crossing_search_ms: float
    fade_ms: float
    target_rms_dbfs: float
    peak_ceiling_dbfs: float
    max_gain_db: float


PROFILES = {
    "game-word": PreparationProfile(
        "game-word", 20, 10, 9, 3, 120, 60, 80, 120, 8, 8, -20, -1, 12
    ),
    "game-syllable": PreparationProfile(
        "game-syllable", 15, 7.5, 8, 3, 70, 40, 35, 55, 5, 5, -20, -1, 10
    ),
}


@dataclass(frozen=True)
class AudioMeasurements:
    duration_s: float
    rms_dbfs: Optional[float]
    sample_peak_dbfs: Optional[float]
    clipped_sample_fraction: float
    dc_offset: float


@dataclass(frozen=True)
class PreparationResult:
    samples: Tuple[float, ...]
    detected_start_sample: int
    detected_end_sample: int
    cut_start_sample: int
    cut_end_sample: int
    applied_gain_db: float
    flags: Tuple[str, ...]
    before: AudioMeasurements
    after: AudioMeasurements


def _db(value: float) -> Optional[float]:
    return 20 * math.log10(value) if value > 0 else None


def measure(samples: Sequence[float], sample_rate: int) -> AudioMeasurements:
    if not samples:
        return AudioMeasurements(0, None, None, 0, 0)
    square_sum = sum(sample * sample for sample in samples)
    rms = math.sqrt(square_sum / len(samples))
    peak = max(abs(sample) for sample in samples)
    return AudioMeasurements(
        duration_s=len(samples) / sample_rate,
        rms_dbfs=_db(rms),
        sample_peak_dbfs=_db(peak),
        clipped_sample_fraction=sum(abs(s) >= 0.999 for s in samples) / len(samples),
        dc_offset=sum(samples) / len(samples),
    )


def _frame_rms(samples: Sequence[float], frame_size: int, hop_size: int) -> List[Tuple[int, float]]:
    frames = []
    for start in range(0, max(1, len(samples) - frame_size + 1), hop_size):
        frame = samples[start : min(len(samples), start + frame_size)]
        if frame:
            frames.append((start, math.sqrt(sum(x * x for x in frame) / len(frame))))
    return frames


def _percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def _active_runs(
    frames: Sequence[Tuple[int, float]], threshold: float, release: float, frame_size: int
) -> List[List[int]]:
    runs: List[List[int]] = []
    current: List[int] = []
    active = False
    for start, energy in frames:
        if not active and energy >= threshold:
            active = True
        elif active and energy < release:
            active = False
        if active:
            current.append(start)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return [[run[0], run[-1] + frame_size] for run in runs]


def _nearest_zero_crossing(samples: Sequence[float], index: int, radius: int) -> int:
    low = max(1, index - radius)
    high = min(len(samples) - 1, index + radius)
    candidates = [i for i in range(low, high + 1) if samples[i - 1] * samples[i] <= 0]
    if not candidates:
        return max(0, min(len(samples), index))
    return min(candidates, key=lambda i: (abs(i - index), abs(samples[i])))


def _fade(samples: List[float], fade_samples: int) -> None:
    count = min(fade_samples, len(samples) // 2)
    for i in range(count):
        gain = (i + 1) / count
        samples[i] *= gain
        samples[-1 - i] *= gain


def prepare(samples: Sequence[float], sample_rate: int, profile: PreparationProfile) -> PreparationResult:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    if not samples:
        raise ValueError("cannot prepare empty audio")
    before = measure(samples, sample_rate)
    flags: List[str] = []
    if before.clipped_sample_fraction > 0:
        flags.append("source_sample_clipping")
    if abs(before.dc_offset) > 0.01:
        flags.append("source_dc_offset")

    frame = max(1, round(profile.frame_ms * sample_rate / 1000))
    hop = max(1, round(profile.hop_ms * sample_rate / 1000))
    frames = _frame_rms(samples, frame, hop)
    energies = [energy for _, energy in frames]
    noise = _percentile(energies, 0.2)
    peak_energy = _percentile(energies, 0.95)
    threshold = max(1e-6, noise * 10 ** (profile.threshold_above_noise_db / 20))
    release = threshold * 10 ** (-profile.release_below_threshold_db / 20)
    runs = _active_runs(frames, threshold, release, frame)

    bridge = round(profile.bridge_silence_ms * sample_rate / 1000)
    merged: List[List[int]] = []
    for start, end in runs:
        if merged and start - merged[-1][1] <= bridge:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    minimum = round(profile.min_active_ms * sample_rate / 1000)
    merged = [run for run in merged if run[1] - run[0] >= minimum]

    # A relative threshold cannot distinguish uniformly loud noise from speech. Abstain when the
    # dynamic contrast is too small, preserving the complete source rather than destructively
    # trimming an uncertain signal.
    contrast_db = 20 * math.log10(peak_energy / max(noise, 1e-12)) if peak_energy else 0
    trim_abstained = not merged or contrast_db < profile.threshold_above_noise_db
    if trim_abstained:
        flags.append("trim_abstained_no_reliable_activity")
        detected_start, detected_end = 0, len(samples)
    else:
        detected_start, detected_end = merged[0][0], min(len(samples), merged[-1][1])

    start = max(0, detected_start - round(profile.leading_padding_ms * sample_rate / 1000))
    end = min(len(samples), detected_end + round(profile.trailing_padding_ms * sample_rate / 1000))
    radius = round(profile.zero_crossing_search_ms * sample_rate / 1000)
    if not trim_abstained:
        start = _nearest_zero_crossing(samples, start, radius)
        end = _nearest_zero_crossing(samples, end, radius)
    if end <= start:
        flags.append("trim_abstained_invalid_bounds")
        start, end = 0, len(samples)

    output = list(samples[start:end])
    _fade(output, round(profile.fade_ms * sample_rate / 1000))
    level = measure(output, sample_rate)
    desired_gain = profile.target_rms_dbfs - level.rms_dbfs if level.rms_dbfs is not None else 0
    gain_db = min(desired_gain, profile.max_gain_db)
    if desired_gain > profile.max_gain_db:
        flags.append("gain_limited_low_level_source")
    if level.sample_peak_dbfs is not None:
        gain_db = min(gain_db, profile.peak_ceiling_dbfs - level.sample_peak_dbfs)
    gain = 10 ** (gain_db / 20)
    output = [max(-1, min(1, sample * gain)) for sample in output]
    after = measure(output, sample_rate)
    return PreparationResult(
        tuple(output), detected_start, detected_end, start, end, gain_db,
        tuple(flags), before, after
    )


def read_pcm_wav(path: Path) -> Tuple[Tuple[float, ...], int]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    if width != 2:
        raise ValueError("initial decoder accepts 16-bit PCM WAV only")
    values = array("h")
    values.frombytes(frames)
    if sys.byteorder != "little":
        values.byteswap()
    if channels < 1:
        raise ValueError("WAV must contain at least one channel")
    mono = []
    for i in range(0, len(values), channels):
        mono.append(sum(values[i : i + channels]) / channels / 32768.0)
    return tuple(mono), rate


def write_pcm_wav(path: Path, samples: Sequence[float], sample_rate: int) -> None:
    values = array("h", (round(max(-1, min(1, x)) * 32767) for x in samples))
    if sys.byteorder != "little":
        values.byteswap()
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(values.tobytes())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_manifest(
    path: Path, source: Path, output: Path, sample_rate: int,
    profile: PreparationProfile, result: PreparationResult
) -> None:
    payload = {
        "schemaVersion": 1,
        "processor": PROCESSOR,
        "source": {"path": str(source), "sha256": sha256(source)},
        "output": {"path": str(output), "sha256": sha256(output)},
        "sampleRate": sample_rate,
        "levelMeasurement": "rms_dbfs",
        "profile": asdict(profile),
        "bounds": {
            "detectedStartSample": result.detected_start_sample,
            "detectedEndSample": result.detected_end_sample,
            "cutStartSample": result.cut_start_sample,
            "cutEndSample": result.cut_end_sample,
        },
        "appliedGainDb": result.applied_gain_db,
        "flags": list(result.flags),
        "before": asdict(result.before),
        "after": asdict(result.after),
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

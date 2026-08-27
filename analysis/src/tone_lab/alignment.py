"""Ordered template alignment for a natural word and its careful syllable clips."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import List, Sequence, Tuple

import numpy as np


ALIGNER = "ordered_logmel_dtw/0.1.0"


@dataclass(frozen=True)
class AlignedInterval:
    syllable_position: int
    start_sample: int
    end_sample: int
    confidence: float


def _log_spectrum_features(samples: Sequence[float], sample_rate: int,
                           frame_ms: float = 25, hop_ms: float = 10,
                           bands: int = 24) -> np.ndarray:
    frame = max(32, round(frame_ms * sample_rate / 1000))
    hop = max(1, round(hop_ms * sample_rate / 1000))
    if len(samples) < frame:
        samples = list(samples) + [0.0] * (frame - len(samples))
    starts = range(0, len(samples) - frame + 1, hop)
    window = np.hanning(frame)
    features = []
    # Log-spaced frequency bins emphasize speech structure without requiring a language model.
    fft_frequencies = np.fft.rfftfreq(frame, 1 / sample_rate)
    edges = np.geomspace(80, min(7600, sample_rate / 2), bands + 1)
    for start in starts:
        spectrum = np.abs(np.fft.rfft(np.asarray(samples[start:start + frame]) * window)) ** 2
        values = []
        for low, high in zip(edges[:-1], edges[1:]):
            selected = spectrum[(fft_frequencies >= low) & (fft_frequencies < high)]
            values.append(math.log((float(np.mean(selected)) if len(selected) else 0.0) + 1e-10))
        features.append(values)
    matrix = np.asarray(features)
    mean = matrix.mean(axis=0, keepdims=True)
    std = matrix.std(axis=0, keepdims=True)
    return (matrix - mean) / np.maximum(std, 1e-6)


def align_syllable_templates(
    natural_samples: Sequence[float], careful_samples: Sequence[Sequence[float]], sample_rate: int,
    hop_ms: float = 10,
) -> Tuple[List[AlignedInterval], float]:
    if not careful_samples:
        raise ValueError("at least one careful syllable template is required")
    natural = _log_spectrum_features(natural_samples, sample_rate, hop_ms=hop_ms)
    templates = [_log_spectrum_features(samples, sample_rate, hop_ms=hop_ms) for samples in careful_samples]
    lengths = [len(template) for template in templates]
    template = np.concatenate(templates, axis=0)
    # Cosine distance after per-utterance feature normalization.
    a = template / np.maximum(np.linalg.norm(template, axis=1, keepdims=True), 1e-9)
    b = natural / np.maximum(np.linalg.norm(natural, axis=1, keepdims=True), 1e-9)
    cost = 1 - np.einsum("ik,jk->ij", a, b)
    rows, columns = cost.shape
    accumulated = np.full((rows, columns), np.inf)
    back = np.zeros((rows, columns, 2), dtype=np.int32)
    accumulated[0, 0] = cost[0, 0]
    for i in range(rows):
        for j in range(columns):
            if i == 0 and j == 0:
                continue
            choices = []
            if i > 0 and j > 0:
                choices.append((accumulated[i - 1, j - 1], i - 1, j - 1))
            if i > 0:
                choices.append((accumulated[i - 1, j] + 0.05, i - 1, j))
            if j > 0:
                choices.append((accumulated[i, j - 1] + 0.05, i, j - 1))
            previous, pi, pj = min(choices, key=lambda item: item[0])
            accumulated[i, j] = cost[i, j] + previous
            back[i, j] = (pi, pj)
    path = []
    i, j = rows - 1, columns - 1
    while True:
        path.append((i, j))
        if i == 0 and j == 0:
            break
        i, j = back[i, j]
    path.reverse()
    offsets = np.cumsum([0] + lengths)
    labels_by_natural_frame = []
    for natural_frame in range(columns):
        mapped = [i for i, j in path if j == natural_frame]
        template_frame = round(float(np.median(mapped)))
        label = min(len(lengths) - 1, int(np.searchsorted(offsets[1:], template_frame, side="right")))
        labels_by_natural_frame.append(label)
    hop = round(hop_ms * sample_rate / 1000)
    intervals = []
    for label in range(len(lengths)):
        frames = [index for index, value in enumerate(labels_by_natural_frame) if value == label]
        if not frames:
            raise ValueError(f"alignment produced no frames for syllable {label}")
        start = frames[0] * hop
        end = min(len(natural_samples), frames[-1] * hop + round(0.025 * sample_rate))
        local_costs = [cost[i, j] for i, j in path if offsets[label] <= i < offsets[label + 1]]
        confidence = max(0.0, min(1.0, 1 - float(np.median(local_costs)) / 2))
        intervals.append(AlignedInterval(label, start, end, confidence))
    normalized_cost = float(accumulated[-1, -1] / len(path))
    return intervals, normalized_cost

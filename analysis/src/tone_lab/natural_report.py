"""Natural-word versus word-specific careful-syllable tone comparison."""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import statistics
from typing import Iterable, List, Optional
import unicodedata

from .alignment import ALIGNER, align_syllable_templates
from .audio import PROFILES, prepare, read_pcm_wav
from .corpus import PairedWordRecord
from .intervals import acoustic_tone_bearing_interval
from .pitch import EXTRACTOR, extract_pitch


def tone_of(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    if "\u0301" in decomposed:
        return "high"
    if "\u0300" in decomposed:
        return "low"
    return "mid"


@dataclass
class PairedObservation:
    word_id: str
    display_text: str
    syllable_position: int
    syllable_text: str
    tone: str
    alignment_start_s: float
    alignment_end_s: float
    alignment_confidence: float
    natural_interval_confidence: Optional[float]
    careful_interval_confidence: Optional[float]
    natural_median_hz: Optional[float]
    careful_median_hz: Optional[float]
    natural_minus_careful_semitones: Optional[float]
    natural_slope_semitones: Optional[float]
    careful_slope_semitones: Optional[float]
    natural_contour_relative_semitones: List[Optional[float]]
    careful_contour_relative_semitones: List[Optional[float]]
    flags: List[str]


def _features_for_interval(samples, rate):
    interval = acoustic_tone_bearing_interval(samples, rate)
    if interval is None:
        return None, None
    features = extract_pitch(samples[interval.start_sample:interval.end_sample], rate)
    return interval, features


def _relative_contour(features) -> List[Optional[float]]:
    if not features or not features.median_hz:
        return [None] * 9
    return [12 * math.log2(value / features.median_hz) if value else None
            for value in features.contour_hz]


def analyze_word(record: PairedWordRecord) -> tuple:
    natural_raw, rate = read_pcm_wav(record.natural_path)
    natural_prepared = prepare(natural_raw, rate, PROFILES["game-word"])
    natural = natural_raw[natural_prepared.cut_start_sample:natural_prepared.cut_end_sample]
    careful = []
    for path in record.careful_syllable_paths:
        raw, careful_rate = read_pcm_wav(path)
        if careful_rate != rate:
            raise ValueError(f"sample-rate mismatch in {record.word_id}")
        prepared = prepare(raw, rate, PROFILES["game-syllable"])
        careful.append(raw[prepared.cut_start_sample:prepared.cut_end_sample])
    aligned, alignment_cost = align_syllable_templates(natural, careful, rate)
    rows = []
    for syllable, careful_samples, aligned_interval in zip(record.syllables, careful, aligned):
        natural_segment = natural[aligned_interval.start_sample:aligned_interval.end_sample]
        natural_interval, natural_pitch = _features_for_interval(natural_segment, rate)
        careful_interval, careful_pitch = _features_for_interval(careful_samples, rate)
        flags = []
        if aligned_interval.confidence < 0.5:
            flags.append("low_alignment_confidence")
        if natural_interval is None:
            flags.append("natural_tone_interval_not_found")
        if careful_interval is None:
            flags.append("careful_tone_interval_not_found")
        for prefix, features in (("natural", natural_pitch), ("careful", careful_pitch)):
            if features:
                flags.extend(f"{prefix}_{flag}" for flag in features.flags)
        natural_hz = natural_pitch.median_hz if natural_pitch else None
        careful_hz = careful_pitch.median_hz if careful_pitch else None
        difference = 12 * math.log2(natural_hz / careful_hz) if natural_hz and careful_hz else None
        rows.append(PairedObservation(
            record.word_id, record.display_text, aligned_interval.syllable_position, syllable,
            tone_of(syllable), aligned_interval.start_sample / rate,
            aligned_interval.end_sample / rate, aligned_interval.confidence,
            natural_interval.confidence if natural_interval else None,
            careful_interval.confidence if careful_interval else None,
            natural_hz, careful_hz, difference,
            natural_pitch.slope_semitones if natural_pitch else None,
            careful_pitch.slope_semitones if careful_pitch else None,
            _relative_contour(natural_pitch), _relative_contour(careful_pitch), flags,
        ))
    return rows, alignment_cost


def _quantile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(len(ordered) - 1, low + 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summarize(rows: List[PairedObservation]) -> List[dict]:
    result = []
    for tone in ("low", "mid", "high"):
        selected = [row for row in rows if row.tone == tone and not row.flags]
        differences = [row.natural_minus_careful_semitones for row in selected
                       if row.natural_minus_careful_semitones is not None]
        natural_slopes = [row.natural_slope_semitones for row in selected if row.natural_slope_semitones is not None]
        careful_slopes = [row.careful_slope_semitones for row in selected if row.careful_slope_semitones is not None]
        natural_hz = [row.natural_median_hz for row in selected if row.natural_median_hz is not None]
        careful_hz = [row.careful_median_hz for row in selected if row.careful_median_hz is not None]
        result.append({
            "tone": tone, "totalCount": sum(row.tone == tone for row in rows),
            "cleanPairCount": len(selected),
            "medianNaturalMinusCarefulSemitones": statistics.median(differences) if differences else None,
            "q25NaturalMinusCarefulSemitones": _quantile(differences, .25) if differences else None,
            "q75NaturalMinusCarefulSemitones": _quantile(differences, .75) if differences else None,
            "medianNaturalSlopeSemitones": statistics.median(natural_slopes) if natural_slopes else None,
            "medianCarefulSlopeSemitones": statistics.median(careful_slopes) if careful_slopes else None,
            "medianNaturalHz": statistics.median(natural_hz) if natural_hz else None,
            "medianCarefulHz": statistics.median(careful_hz) if careful_hz else None,
        })
    return result


def write_natural_report(records: Iterable[PairedWordRecord], output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    observations = []
    word_alignment_costs = {}
    errors = []
    for record in records:
        try:
            rows, cost = analyze_word(record)
            observations.extend(rows)
            word_alignment_costs[record.word_id] = cost
        except Exception as error:
            errors.append({"wordId": record.word_id, "error": str(error)})
    summaries = summarize(observations)
    payload = {
        "schemaVersion": 1, "aligner": ALIGNER, "pitchExtractor": EXTRACTOR,
        "scope": "legacy speaker3 exact word-specific natural/careful pairs",
        "summaries": summaries, "wordAlignmentCosts": word_alignment_costs,
        "errors": errors, "observations": [asdict(row) for row in observations],
    }
    (output / "natural-vs-careful.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8"
    )
    if observations:
        with (output / "natural-vs-careful.csv").open("w", newline="", encoding="utf-8") as handle:
            fields = [field for field in asdict(observations[0])
                      if field not in {"natural_contour_relative_semitones", "careful_contour_relative_semitones"}]
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            for row in observations:
                values = asdict(row)
                values["flags"] = json.dumps(values["flags"])
                writer.writerow({field: values[field] for field in fields})
    _write_summary(output / "SUMMARY.md", summaries, observations, word_alignment_costs, errors)
    _write_plot(output / "natural-vs-careful-contours.png", observations)


def _write_summary(path, summaries, rows, costs, errors):
    lines = [
        "# Speaker3 natural versus careful tone report", "",
        "Natural syllable intervals are aligned in order against that word's own careful syllable",
        "templates using log-spectrum dynamic time warping, then refined to a tone-bearing interval.", "",
        f"Words analyzed: {len(costs)}. Syllable pairs: {len(rows)}. Word errors: {len(errors)}.", "",
        "| Tone | total | clean pairs | natural Hz | careful Hz | natural − careful pitch | natural slope | careful slope |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summaries:
        def value(field):
            item = row[field]
            return f"{item:+.2f} st" if item is not None else "—"
        lines.append(
            f"| {row['tone']} | {row['totalCount']} | {row['cleanPairCount']} | "
            f"{row['medianNaturalHz']:.1f} | {row['medianCarefulHz']:.1f} | "
            f"{value('medianNaturalMinusCarefulSemitones')} | "
            f"{value('medianNaturalSlopeSemitones')} | {value('medianCarefulSlopeSemitones')} |"
        )
    flagged = sum(bool(row.flags) for row in rows)
    lines += ["", f"Flagged syllable pairs excluded from clean summaries: {flagged}.",
              "See `natural-vs-careful-contours.png` for median within-interval contour shapes.", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_plot(path, rows):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    colours = {"natural": "#2767a8", "careful": "#c24a3a"}
    figure, axes = plt.subplots(1, 3, figsize=(12, 4), sharey=True)
    x = list(range(10, 100, 10))
    for axis, tone in zip(axes, ("low", "mid", "high")):
        selected = [row for row in rows if row.tone == tone and not row.flags]
        for style, field in (("natural", "natural_contour_relative_semitones"),
                             ("careful", "careful_contour_relative_semitones")):
            contour = []
            for point in range(9):
                values = [getattr(row, field)[point] for row in selected if getattr(row, field)[point] is not None]
                contour.append(statistics.median(values) if values else None)
            axis.plot(x, contour, marker="o", markersize=3, label=style.title(), color=colours[style])
        axis.axhline(0, color="#aaaaaa", linewidth=.8)
        axis.set_title(tone.title())
        axis.set_xlabel("Normalized tone-bearing interval (%)")
        axis.set_ylabel("Semitones from each interval's median")
        axis.legend()
    figure.suptitle("Speaker3: natural versus careful contour shape (exploratory alignment)")
    figure.tight_layout()
    figure.savefig(path, dpi=160)
    plt.close(figure)

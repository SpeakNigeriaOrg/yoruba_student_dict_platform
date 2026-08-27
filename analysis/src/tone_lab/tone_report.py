"""Exploratory speaker-by-tone summaries from isolated syllable recordings."""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import statistics
from typing import Iterable, List, Optional

from .audio import PROFILES, prepare, read_pcm_wav
from .corpus import CorpusAudioRecord
from .intervals import acoustic_tone_bearing_interval, central_interval
from .pitch import EXTRACTOR, extract_pitch


@dataclass
class ToneObservation:
    record_id: str
    speaker_id: str
    tone: str
    syllable_candidates: List[str]
    median_hz: Optional[float]
    semitones_from_speaker_centre: Optional[float]
    q25_hz: Optional[float]
    q75_hz: Optional[float]
    slope_semitones: Optional[float]
    voiced_fraction: float
    contour_hz: List[Optional[float]]
    contour_semitones_from_file_median: List[Optional[float]]
    interval_comparison: dict
    flags: List[str]


def _quantile(values: List[float], fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(len(ordered) - 1, low + 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def build_observations(records: Iterable[CorpusAudioRecord]) -> List[ToneObservation]:
    observations = []
    for record in records:
        if record.recording_style != "careful_syllable" or record.intended_tone not in {"low", "mid", "high"}:
            continue
        samples, rate = read_pcm_wav(record.path)
        prepared = prepare(samples, rate, PROFILES["game-syllable"])
        # Trimming only supplies analysis bounds. Gain-normalized delivery samples are never used
        # for tone extraction.
        raw_interval = samples[prepared.cut_start_sample:prepared.cut_end_sample]
        features = extract_pitch(raw_interval, rate)
        central = central_interval(raw_interval)
        acoustic = acoustic_tone_bearing_interval(raw_interval, rate)
        comparison = {}
        for name, interval in (("central_20_80", central), ("acoustic_tone_bearing", acoustic)):
            if interval is None:
                comparison[name] = {"available": False, "flags": ["interval_not_found"]}
                continue
            interval_samples = raw_interval[interval.start_sample:interval.end_sample]
            interval_pitch = extract_pitch(interval_samples, rate)
            comparison[name] = {
                "available": True, "startSample": interval.start_sample,
                "endSample": interval.end_sample, "confidence": interval.confidence,
                "source": interval.source, "medianHz": interval_pitch.median_hz,
                "slopeSemitones": interval_pitch.slope_semitones,
                "voicedFraction": interval_pitch.voiced_fraction,
                "contourHz": list(interval_pitch.contour_hz),
                "flags": list(interval.flags) + list(interval_pitch.flags),
            }
        flags = list(features.flags)
        if record.provenance_status != "exact":
            flags.append("provenance_" + record.provenance_status)
        observations.append(ToneObservation(
            record.record_id, record.speaker_id, record.intended_tone,
            list(record.syllable_text_candidates), features.median_hz, None,
            features.q25_hz, features.q75_hz, features.slope_semitones,
            features.voiced_fraction, list(features.contour_hz), [], comparison, flags,
        ))

    for row in observations:
        row.contour_semitones_from_file_median = [
            12 * math.log2(value / row.median_hz) if value and row.median_hz else None
            for value in row.contour_hz
        ]

    # Equal tone weighting prevents an imbalanced inventory from defining a speaker's centre.
    for speaker in sorted({row.speaker_id for row in observations}):
        tone_medians = []
        for tone in ("low", "mid", "high"):
            values = [row.median_hz for row in observations
                      if row.speaker_id == speaker and row.tone == tone and row.median_hz]
            if values:
                tone_medians.append(statistics.median(values))
        if not tone_medians:
            continue
        centre = math.exp(statistics.mean(math.log(value) for value in tone_medians))
        for row in observations:
            if row.speaker_id == speaker and row.median_hz:
                row.semitones_from_speaker_centre = 12 * math.log2(row.median_hz / centre)
        # A roughly octave-separated singleton is a classic pitch-tracker failure. Keep the raw
        # estimate, but flag it for review and exclude it from distribution summaries.
        for tone in ("low", "mid", "high"):
            tone_rows = [row for row in observations
                         if row.speaker_id == speaker and row.tone == tone and row.median_hz]
            if not tone_rows:
                continue
            tone_centre = statistics.median(row.median_hz for row in tone_rows if row.median_hz)
            for row in tone_rows:
                distance = abs(12 * math.log2(row.median_hz / tone_centre))
                if distance >= 7:
                    row.flags.append("possible_octave_error")
    return observations


def summarize(observations: List[ToneObservation]) -> List[dict]:
    summaries = []
    for speaker in sorted({row.speaker_id for row in observations}):
        for tone in ("low", "mid", "high"):
            rows = [row for row in observations if row.speaker_id == speaker and row.tone == tone and row.median_hz]
            reliable = [row for row in rows if not ({"low_voicing_coverage", "possible_octave_error"} & set(row.flags))]
            hz = [row.median_hz for row in reliable if row.median_hz is not None]
            semitones = [row.semitones_from_speaker_centre for row in reliable if row.semitones_from_speaker_centre is not None]
            contours = []
            shape_contours = []
            for point in range(9):
                values = [row.contour_hz[point] for row in reliable if row.contour_hz[point] is not None]
                contours.append(statistics.median(values) if values else None)
                shape_values = [row.contour_semitones_from_file_median[point] for row in reliable
                                if row.contour_semitones_from_file_median[point] is not None]
                shape_contours.append(statistics.median(shape_values) if shape_values else None)
            slopes = [row.slope_semitones for row in reliable if row.slope_semitones is not None]
            rising = sum(value > 1 for value in slopes)
            falling = sum(value < -1 for value in slopes)
            level = len(slopes) - rising - falling
            excursions = []
            for row in reliable:
                contour = [value for value in row.contour_semitones_from_file_median if value is not None]
                if contour:
                    excursions.append(max(contour) - min(contour))
            summaries.append({
                "speakerId": speaker, "tone": tone, "count": len(rows),
                "reliableCount": len(reliable),
                "medianHz": statistics.median(hz) if hz else None,
                "q25Hz": _quantile(hz, 0.25) if hz else None,
                "q75Hz": _quantile(hz, 0.75) if hz else None,
                "medianSemitonesFromSpeakerCentre": statistics.median(semitones) if semitones else None,
                "q25Semitones": _quantile(semitones, 0.25) if semitones else None,
                "q75Semitones": _quantile(semitones, 0.75) if semitones else None,
                "medianContourHz": contours,
                "medianContourShapeSemitones": shape_contours,
                "medianStartToEndSemitones": statistics.median(slopes) if slopes else None,
                "q25StartToEndSemitones": _quantile(slopes, 0.25) if slopes else None,
                "q75StartToEndSemitones": _quantile(slopes, 0.75) if slopes else None,
                "medianExcursionSemitones": statistics.median(excursions) if excursions else None,
                "risingCount": rising, "levelCount": level, "fallingCount": falling,
            })
    return summaries


def write_tone_report(records: Iterable[CorpusAudioRecord], output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    observations = build_observations(records)
    summaries = summarize(observations)
    method_summaries = summarize_interval_methods(observations)
    payload = {
        "schemaVersion": 1, "extractor": EXTRACTOR,
        "scope": "legacy isolated careful-syllable clips; source word/position unavailable",
        "summaries": summaries, "intervalMethodSummaries": method_summaries,
        "observations": [asdict(row) for row in observations],
    }
    (output / "tone-distributions.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8"
    )
    with (output / "tone-distributions.csv").open("w", newline="", encoding="utf-8") as handle:
        fields = [key for key in summaries[0].keys()
                  if key not in {"medianContourHz", "medianContourShapeSemitones"}] if summaries else []
        writer = csv.DictWriter(handle, fieldnames=fields)
        if fields:
            writer.writeheader()
            writer.writerows({key: value for key, value in row.items() if key in fields} for row in summaries)
    with (output / "contour-method-comparison.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(method_summaries[0].keys()))
        writer.writeheader()
        writer.writerows(method_summaries)
    _write_markdown(output / "SUMMARY.md", summaries, observations, method_summaries)
    _write_plot(output / "tone-distributions.png", observations)
    _write_contour_plot(output / "tone-contours.png", summaries)
    _write_acoustic_contour_plot(output / "tone-contours-acoustic.png", observations)


def summarize_interval_methods(observations: List[ToneObservation]) -> List[dict]:
    result = []
    methods = ("whole_trimmed", "central_20_80", "acoustic_tone_bearing")
    for speaker in sorted({row.speaker_id for row in observations}):
        for tone in ("low", "mid", "high"):
            source_rows = [row for row in observations if row.speaker_id == speaker and row.tone == tone]
            for method in methods:
                slopes = []
                available = 0
                for row in source_rows:
                    if {"low_voicing_coverage", "possible_octave_error"} & set(row.flags):
                        continue
                    if method == "whole_trimmed":
                        slope = row.slope_semitones
                        available += slope is not None
                    else:
                        item = row.interval_comparison[method]
                        slope = item.get("slopeSemitones") if item.get("available") else None
                        available += item.get("available", False)
                    if slope is not None:
                        slopes.append(slope)
                result.append({
                    "speakerId": speaker, "tone": tone, "method": method,
                    "availableCount": available, "slopeCount": len(slopes),
                    "medianStartToEndSemitones": statistics.median(slopes) if slopes else None,
                    "q25StartToEndSemitones": _quantile(slopes, 0.25) if slopes else None,
                    "q75StartToEndSemitones": _quantile(slopes, 0.75) if slopes else None,
                })
    return result


def _write_markdown(path: Path, summaries: List[dict], observations: List[ToneObservation],
                    method_summaries: List[dict]) -> None:
    lines = [
        "# Legacy exploratory tone distributions", "",
        "Praat autocorrelation estimates from isolated careful-syllable clips. These are preliminary:",
        "the deprecated pipeline discarded each clip's source word and position. Values are medians of",
        "per-file median F0; speaker-relative values use an equal-weight H/M/L geometric centre.", "",
        "| Speaker | Tone | n | reliable | median Hz | IQR Hz | median relative pitch |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summaries:
        relative = row["medianSemitonesFromSpeakerCentre"]
        lines.append(
            f"| {row['speakerId']} | {row['tone']} | {row['count']} | {row['reliableCount']} | "
            f"{row['medianHz']:.1f} | {row['q25Hz']:.1f}–{row['q75Hz']:.1f} | {relative:+.2f} st |"
        )
    low_voicing = sum("low_voicing_coverage" in row.flags for row in observations)
    octave = sum("possible_octave_error" in row.flags for row in observations)
    lines += ["", f"Low-voicing files flagged: {low_voicing} of {len(observations)}.",
              f"Possible octave-tracking errors excluded from summaries: {octave}.", ""]
    lines += [
        "## Contour shape", "",
        "Movement is the difference between local pitch near 10% and 90% of each clip. `Level`",
        "means within ±1 semitone; this is a descriptive threshold, not a Yoruba category boundary.",
        "Excursion is the median within-clip maximum minus minimum across the nine contour points.", "",
        "| Speaker | Tone | median movement | movement IQR | rising / level / falling | median excursion |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in summaries:
        lines.append(
            f"| {row['speakerId']} | {row['tone']} | {row['medianStartToEndSemitones']:+.2f} st | "
            f"{row['q25StartToEndSemitones']:+.2f}–{row['q75StartToEndSemitones']:+.2f} st | "
            f"{row['risingCount']} / {row['levelCount']} / {row['fallingCount']} | "
            f"{row['medianExcursionSemitones']:.2f} st |"
        )
    lines += ["", "See `tone-contours.png` for median shapes after centering every file on its own median pitch.", ""]
    lines += [
        "## Interval-method comparison", "",
        "`whole_trimmed` includes the full conservatively trimmed clip. `central_20_80` is the",
        "fixed baseline. `acoustic_tone_bearing` uses Praat voicing strength plus relative intensity,",
        "bridges brief pitch dropouts, and abstains when it cannot find at least 60 ms of evidence.", "",
        "| Speaker | Tone | whole clip | central 20–80% | acoustic interval | acoustic n |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    by_key = {(row["speakerId"], row["tone"], row["method"]): row for row in method_summaries}
    for speaker in sorted({row["speakerId"] for row in method_summaries}):
        for tone in ("low", "mid", "high"):
            whole = by_key[(speaker, tone, "whole_trimmed")]
            central = by_key[(speaker, tone, "central_20_80")]
            acoustic = by_key[(speaker, tone, "acoustic_tone_bearing")]
            def movement(row):
                value = row["medianStartToEndSemitones"]
                return f"{value:+.2f} st" if value is not None else "—"
            lines.append(
                f"| {speaker} | {tone} | {movement(whole)} | {movement(central)} | "
                f"{movement(acoustic)} | {acoustic['slopeCount']} |"
            )
    abstained = sum(not row.interval_comparison["acoustic_tone_bearing"].get("available", False)
                    for row in observations)
    lines += ["", f"Acoustic interval detector abstentions: {abstained} of {len(observations)}.", ""]
    lines += ["See `tone-contours-acoustic.png` for the median shapes within detected tone-bearing intervals.", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_plot(path: Path, observations: List[ToneObservation]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    speakers = sorted({row.speaker_id for row in observations})
    tones = ("low", "mid", "high")
    colours = {"low": "#315a9a", "mid": "#777777", "high": "#b43c3c"}
    figure, axes = plt.subplots(1, len(speakers), figsize=(4 * len(speakers), 4), sharey=False)
    if len(speakers) == 1:
        axes = [axes]
    for axis, speaker in zip(axes, speakers):
        values = [[row.semitones_from_speaker_centre for row in observations
                   if row.speaker_id == speaker and row.tone == tone
                   and row.semitones_from_speaker_centre is not None
                   and not ({"low_voicing_coverage", "possible_octave_error"} & set(row.flags))]
                  for tone in tones]
        boxes = axis.boxplot(values, tick_labels=[tone.title() for tone in tones], patch_artist=True)
        for patch, tone in zip(boxes["boxes"], tones):
            patch.set_facecolor(colours[tone])
        axis.axhline(0, color="#aaaaaa", linewidth=0.8)
        axis.set_title(speaker)
        axis.set_ylabel("Semitones from balanced speaker centre")
    figure.suptitle("Legacy careful-syllable tone distributions (exploratory)")
    figure.tight_layout()
    figure.savefig(path, dpi=160)
    plt.close(figure)


def _write_contour_plot(path: Path, summaries: List[dict]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    speakers = sorted({row["speakerId"] for row in summaries})
    colours = {"low": "#315a9a", "mid": "#777777", "high": "#b43c3c"}
    figure, axes = plt.subplots(1, len(speakers), figsize=(4 * len(speakers), 4), sharey=True)
    if len(speakers) == 1:
        axes = [axes]
    x = list(range(10, 100, 10))
    for axis, speaker in zip(axes, speakers):
        for row in (item for item in summaries if item["speakerId"] == speaker):
            axis.plot(x, row["medianContourShapeSemitones"], marker="o", markersize=3,
                      label=row["tone"].title(), color=colours[row["tone"]])
        axis.axhline(0, color="#aaaaaa", linewidth=0.8)
        axis.set_title(speaker)
        axis.set_xlabel("Normalized clip time (%)")
        axis.set_ylabel("Semitones from each file's median")
        axis.legend()
    figure.suptitle("Median within-syllable F0 contour shape (legacy, exploratory)")
    figure.tight_layout()
    figure.savefig(path, dpi=160)
    plt.close(figure)


def _write_acoustic_contour_plot(path: Path, observations: List[ToneObservation]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    speakers = sorted({row.speaker_id for row in observations})
    colours = {"low": "#315a9a", "mid": "#777777", "high": "#b43c3c"}
    figure, axes = plt.subplots(1, len(speakers), figsize=(4 * len(speakers), 4), sharey=True)
    if len(speakers) == 1:
        axes = [axes]
    x = list(range(10, 100, 10))
    for axis, speaker in zip(axes, speakers):
        for tone in ("low", "mid", "high"):
            rows = [row for row in observations if row.speaker_id == speaker and row.tone == tone
                    and not ({"low_voicing_coverage", "possible_octave_error"} & set(row.flags))]
            contour = []
            for point in range(9):
                values = []
                for row in rows:
                    item = row.interval_comparison["acoustic_tone_bearing"]
                    value = item.get("contourHz", [None] * 9)[point] if item.get("available") else None
                    median = item.get("medianHz")
                    if value and median:
                        values.append(12 * math.log2(value / median))
                contour.append(statistics.median(values) if values else None)
            axis.plot(x, contour, marker="o", markersize=3, label=tone.title(), color=colours[tone])
        axis.axhline(0, color="#aaaaaa", linewidth=0.8)
        axis.set_title(speaker)
        axis.set_xlabel("Normalized tone-bearing interval (%)")
        axis.set_ylabel("Semitones from each interval's median")
        axis.legend()
    figure.suptitle("Median acoustically aligned tone-bearing contours (legacy, exploratory)")
    figure.tight_layout()
    figure.savefig(path, dpi=160)
    plt.close(figure)

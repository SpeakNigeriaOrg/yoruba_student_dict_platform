"""Format-independent corpus audio audit."""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
import json
from pathlib import Path
from typing import Iterable, List, Optional

from .audio import PROFILES, measure, prepare, read_pcm_wav, sha256
from .corpus import CorpusAudioRecord


AUDITOR = "tone_lab.audit/0.1.0"


@dataclass(frozen=True)
class AuditRow:
    record_id: str
    path: str
    sha256: str
    speaker_id: str
    recording_style: str
    word_id: Optional[str]
    display_text: Optional[str]
    expected_syllables: List[str]
    syllable_text_candidates: List[str]
    intended_tone: Optional[str]
    provenance_status: str
    provenance_note: Optional[str]
    sample_rate: Optional[int]
    duration_s: Optional[float]
    rms_dbfs: Optional[float]
    sample_peak_dbfs: Optional[float]
    clipped_sample_fraction: Optional[float]
    dc_offset: Optional[float]
    detected_start_s: Optional[float]
    detected_end_s: Optional[float]
    proposed_cut_start_s: Optional[float]
    proposed_cut_end_s: Optional[float]
    proposed_fraction_removed: Optional[float]
    flags: List[str]
    error: Optional[str]


def audit_record(record: CorpusAudioRecord) -> AuditRow:
    try:
        samples, sample_rate = read_pcm_wav(record.path)
        measurements = measure(samples, sample_rate)
        profile_name = "game-word" if record.recording_style == "natural_word" else "game-syllable"
        result = prepare(samples, sample_rate, PROFILES[profile_name])
        flags = list(result.flags)
        if record.provenance_status != "exact":
            flags.append("provenance_" + record.provenance_status)
        return AuditRow(
            record.record_id, str(record.path), sha256(record.path), record.speaker_id,
            record.recording_style, record.word_id, record.display_text,
            list(record.expected_syllables), list(record.syllable_text_candidates),
            record.intended_tone, record.provenance_status, record.provenance_note,
            sample_rate, measurements.duration_s, measurements.rms_dbfs,
            measurements.sample_peak_dbfs, measurements.clipped_sample_fraction,
            measurements.dc_offset, result.detected_start_sample / sample_rate,
            result.detected_end_sample / sample_rate, result.cut_start_sample / sample_rate,
            result.cut_end_sample / sample_rate, 1 - len(result.samples) / len(samples),
            flags, None,
        )
    except Exception as error:
        return AuditRow(
            record.record_id, str(record.path), "", record.speaker_id, record.recording_style,
            record.word_id, record.display_text, list(record.expected_syllables),
            list(record.syllable_text_candidates), record.intended_tone,
            record.provenance_status, record.provenance_note,
            None, None, None, None, None, None, None, None, None, None, None,
            ["unreadable_audio"], str(error),
        )


def write_audit(records: Iterable[CorpusAudioRecord], output_directory: Path) -> List[AuditRow]:
    output_directory.mkdir(parents=True, exist_ok=True)
    rows = [audit_record(record) for record in records]
    json_path = output_directory / "audio-audit.json"
    csv_path = output_directory / "audio-audit.csv"
    payload = {"schemaVersion": 1, "auditor": AUDITOR, "records": [asdict(row) for row in rows]}
    json_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if rows:
        fieldnames = list(asdict(rows[0]).keys())
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                values = asdict(row)
                for field in ("expected_syllables", "syllable_text_candidates", "flags"):
                    values[field] = json.dumps(values[field], ensure_ascii=False)
                writer.writerow(values)
    return rows

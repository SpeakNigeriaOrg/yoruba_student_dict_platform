"""Forward-looking corpus records.

Adapters may populate these records from legacy files, database rows, or future artifact stores.
No deprecated naming convention belongs in this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple


@dataclass(frozen=True)
class CorpusAudioRecord:
    record_id: str
    path: Path
    speaker_id: str
    recording_style: str
    word_id: Optional[str] = None
    display_text: Optional[str] = None
    expected_syllables: Tuple[str, ...] = ()
    syllable_text_candidates: Tuple[str, ...] = ()
    intended_tone: Optional[str] = None
    provenance_status: str = "exact"
    provenance_note: Optional[str] = None


@dataclass(frozen=True)
class PairedWordRecord:
    """One natural word recording and its word-specific careful syllable clips."""
    record_id: str
    speaker_id: str
    word_id: str
    display_text: str
    syllables: Tuple[str, ...]
    natural_path: Path
    careful_syllable_paths: Tuple[Path, ...]
    provenance_status: str = "exact"

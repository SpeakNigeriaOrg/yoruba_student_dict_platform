"""Read-only adapter for yoruba-student-dict's deprecated staged layout.

The old pipeline retained one file per speaker + safe syllable key and discarded the originating
word/position when keys repeated. This adapter reports candidate text but never invents origin.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

from ..corpus import CorpusAudioRecord


def _load_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _syllable_index(syllables: dict) -> Dict[Tuple[str, str], List[Tuple[str, str]]]:
    index: Dict[Tuple[str, str], List[Tuple[str, str]]] = {}
    for speaker, entries in syllables.items():
        for text, metadata in entries.items():
            filename = Path(metadata["audio"]).name
            index.setdefault((speaker, filename), []).append((text, metadata["tone"]))
    return index


def discover(repository: Path) -> Iterable[CorpusAudioRecord]:
    """Discover records without altering the legacy repository."""
    vocabulary = _load_json(repository / "public" / "vocab.json")
    syllables = _load_json(repository / "public" / "syllables.json")
    syllable_index = _syllable_index(syllables)
    staged = repository / "content" / "staged"

    for speaker_directory in sorted((staged / "words").glob("speaker*")):
        speaker = speaker_directory.name
        for path in sorted(speaker_directory.glob("*.wav")):
            word_id = path.stem
            entry = vocabulary.get(word_id)
            known = entry is not None
            yield CorpusAudioRecord(
                record_id=f"legacy:word:{speaker}:{word_id}", path=path, speaker_id=speaker,
                recording_style="natural_word", word_id=word_id,
                display_text=entry.get("displayText") if known else None,
                expected_syllables=tuple(entry.get("syllables", ())) if known else (),
                provenance_status="exact" if known else "unmapped",
                provenance_note=None if known else "word filename is absent from legacy vocab.json",
            )

    for speaker_directory in sorted((staged / "syllables").glob("speaker*")):
        speaker = speaker_directory.name
        for path in sorted(speaker_directory.glob("*.wav")):
            candidates = syllable_index.get((speaker, path.name), [])
            texts = tuple(sorted({text for text, _ in candidates}))
            tones = {tone for _, tone in candidates}
            tone = next(iter(tones)) if len(tones) == 1 else None
            # Even one text candidate does not restore the word/position that supplied these bytes.
            status = "ambiguous_origin" if candidates else "unmapped"
            note = (
                "legacy staging retained one clip per speaker/safe syllable key; source word and "
                "position were discarded"
                if candidates else "filename is absent from legacy syllables.json"
            )
            yield CorpusAudioRecord(
                record_id=f"legacy:syllable:{speaker}:{path.stem}", path=path,
                speaker_id=speaker, recording_style="careful_syllable",
                syllable_text_candidates=texts, intended_tone=tone,
                provenance_status=status, provenance_note=note,
            )

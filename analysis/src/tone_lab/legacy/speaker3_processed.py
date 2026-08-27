"""Adapter for speaker3's deprecated pre-staging output.

Unlike staged_corpus, this source preserves exact word and syllable-position provenance. Directory
and output.json interpretation remain quarantined in the legacy package.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable
import unicodedata

from ..corpus import PairedWordRecord


def discover(repository: Path) -> Iterable[PairedWordRecord]:
    processed = repository / "content" / "processed"
    with (processed / "output.json").open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    for word_id, metadata in manifest.items():
        display = metadata["displayText"]
        syllables = tuple(metadata["syllables"])
        directory = processed / unicodedata.normalize("NFD", display)
        # macOS may expose decomposed names while Path construction came from composed JSON.
        if not directory.is_dir():
            matches = [candidate for candidate in processed.iterdir()
                       if candidate.is_dir() and unicodedata.normalize("NFC", candidate.name) == unicodedata.normalize("NFC", display)]
            if len(matches) != 1:
                continue
            directory = matches[0]
        def matching_file(text: str) -> Path:
            matches = [path for path in directory.glob("*.wav")
                       if unicodedata.normalize("NFC", path.stem) == unicodedata.normalize("NFC", text)]
            if len(matches) != 1:
                raise ValueError(f"expected one {text!r} WAV in {directory}, found {len(matches)}")
            return matches[0]
        yield PairedWordRecord(
            record_id=f"legacy:speaker3-paired:{word_id}", speaker_id="speaker3",
            word_id=word_id, display_text=display, syllables=syllables,
            natural_path=matching_file(display),
            careful_syllable_paths=tuple(matching_file(syllable) for syllable in syllables),
        )

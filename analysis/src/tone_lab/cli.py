from __future__ import annotations

import argparse
from pathlib import Path

from .audio import PROFILES, prepare, read_pcm_wav, write_manifest, write_pcm_wav
from .audit import write_audit
from .legacy.staged_corpus import discover as discover_legacy_staged
from .tone_report import write_tone_report
from .natural_report import write_natural_report
from .legacy.speaker3_processed import discover as discover_speaker3_paired


def main() -> None:
    parser = argparse.ArgumentParser(prog="yoruba-tone-lab")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("prepare", help="create a trimmed and level-normalized WAV")
    command.add_argument("source", type=Path)
    command.add_argument("output", type=Path)
    command.add_argument("--profile", choices=sorted(PROFILES), default="game-word")
    legacy = commands.add_parser("legacy-audit", help="audit deprecated yoruba-student-dict staged audio")
    legacy.add_argument("repository", type=Path, help="path to the legacy yoruba-student-dict repository")
    legacy.add_argument("output", type=Path, help="directory for JSON and CSV reports")
    tone = commands.add_parser("legacy-tone-report", help="summarize pitch by speaker and tone")
    tone.add_argument("repository", type=Path, help="path to the legacy yoruba-student-dict repository")
    tone.add_argument("output", type=Path, help="directory for JSON, CSV, Markdown, and plot outputs")
    paired = commands.add_parser("legacy-speaker3-natural-report", help="compare exact speaker3 natural/careful pairs")
    paired.add_argument("repository", type=Path, help="path to the legacy yoruba-student-dict repository")
    paired.add_argument("output", type=Path, help="directory for report outputs")
    args = parser.parse_args()

    if args.command == "prepare":
        samples, sample_rate = read_pcm_wav(args.source)
        result = prepare(samples, sample_rate, PROFILES[args.profile])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        write_pcm_wav(args.output, result.samples, sample_rate)
        write_manifest(Path(str(args.output) + ".json"), args.source, args.output, sample_rate, PROFILES[args.profile], result)
    elif args.command == "legacy-audit":
        rows = write_audit(discover_legacy_staged(args.repository), args.output)
        errors = sum(row.error is not None for row in rows)
        print(f"audited {len(rows)} files ({errors} errors); reports written to {args.output}")
    elif args.command == "legacy-tone-report":
        write_tone_report(discover_legacy_staged(args.repository), args.output)
        print(f"tone report written to {args.output}")
    elif args.command == "legacy-speaker3-natural-report":
        write_natural_report(discover_speaker3_paired(args.repository), args.output)
        print(f"speaker3 natural/careful report written to {args.output}")


if __name__ == "__main__":
    main()

# db/

Schema and migrations for the Postgres Flexible Server database that
replaces the local tool's flat JSON files
(`vocab.json`/`dictionary_overrides.json`/`dictionary_diagnostics.json`) and
the current lossy, deduplicating audio-filename scheme.

See `yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md` for the full schema
design (`Golden_Record`, `Assignments`, `Contributions`, `Users`,
`Speakers`, `Utterances`, `SyllableObservations`,
`CanonicalSyllableSelections`) and the reasoning behind it - in short:
identity for audio recordings lives in the database (exact syllable text,
plus generated tone-insensitive/orthography-insensitive columns reusing the
same three-tier normalization as `shared/`'s ported `yoruba_orthography`),
not in the filename, so every individual recording is preserved rather than
silently overwritten, and "every recording of syllable X across every word
and speaker" is a plain indexed query.

Not yet populated with actual migration files - placeholder pending the
first real implementation pass.

# db/

Schema and migrations for the Postgres Flexible Server database that
replaces the local tool's flat JSON files
(`vocab.json`/`dictionary_overrides.json`/`dictionary_diagnostics.json`) and
the current lossy, deduplicating audio-filename scheme.

## Running migrations

```
cp ../.env.example ../.env   # then fill in DATABASE_URL
npm install
npm run migrate
```

(or from the repo root: `npm run db:migrate`)

Plain numbered `.sql` files in `migrations/`, applied in order and tracked
in a `schema_migrations` table by `migrate.mjs` - no ORM/migration
framework, deliberately, matching this project's general preference for
minimal tooling. Add new schema changes as a new `NNNN_description.sql`
file; never edit an already-applied one.

## Design

See `yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md` for the full
reasoning. In short:

- **`golden_record`** + **`golden_record_components`** replace `vocab.json`.
  Components are a real join table (word_id, position, component_word_id),
  not an array column - Postgres arrays can't carry a per-element foreign
  key, so this is what turns the old Python tool's warning-only
  `invalidComponents` check into an actual database constraint.
- **`users`** distinguishes the trusted curator(s) from any other
  authenticated identity - SSO alone doesn't know who's who.
- **`assignments`** / **`contributions`** back the per-user work-assignment
  and volunteer-suggestion-review-queue features.
- **`utterances`** / **`syllable_observations`** hold audio, with identity
  living in real columns (`syllable_text` + generated tone/underdot-
  insensitive forms, computed once by `shared/`'s ported orthography logic
  - not re-derived a third time in SQL) rather than encoded lossily into a
  filename. Nothing is ever skipped/overwritten on insert - every take from
  every speaker is preserved, which is the entire point: "every recording
  of syllable kan, across every word and every speaker" is just
  `select * from syllable_observations_enriched where syllable_orthography_insensitive = 'kan'`.
- **`canonical_utterance_selections`** / **`canonical_syllable_selections`**
  are the deferred acoustic-ML canonical-selection algorithm's manual v1
  stand-in - a curator flags a best take by hand for now - and are what the
  publish step reads to push the current legacy R2 layout
  (`words/{speaker}/{word_id}.wav`, `syllables/{speaker}/{legacy_syllable_key}.wav`)
  so `syllable_game_concept` needs no changes at all.

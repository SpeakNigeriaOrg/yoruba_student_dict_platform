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

## After 0012: bootstrap the first curator

`0012_google_identity.sql` moves identity to Google email addresses and does
**not** map existing GitHub-handle rows to Google addresses (a deliberate clean
start). Registering a user is curator-only, so with no curators there is no way
to create the first one through the app. Insert it once by hand:

```sql
insert into users (email, display_name, role)
values ('admin@speaknigeria.org', 'Admin', 'curator');
```

Old rows are left in place rather than deleted, so every foreign-key reference
stays valid and no history is destroyed - `word_decisions.decided_by`,
`assignments`, `contributions.submitted_by`, `speakers.user_id`,
`word_images.uploaded_by` and the rest all still resolve. The people behind
them simply get new `user_id`s on first Google login.

**A related worry that turned out not to apply here.** `AxisDecided.audio` is
scoped per-user by design (`api/src/reviewShared.ts`), so the concern was that
orphaning accounts would cost returning volunteers their recording history. It
didn't: checked against production after the cutover, all three `speakers` rows
have `user_id = NULL`. They were created by the legacy import scripts
(`migrateLegacyAudio.mjs`, `migrateSpeaker1And2.mjs`), which never linked a
speaker to a platform account, so the 189 existing recordings were never
attributed to a login and nothing was lost.

Consequences of that, both correct: those recordings still publish normally
(the R2 pipeline joins `speakers`, not logins), and every word shows audio as
still-to-do for every account, because no account has in fact recorded anything
through the app yet.

Recordings made through the app *do* get a user link, via
`getOrCreateSpeakerForUser` in `api/src/speakers.ts`. So if a real user ever
needs to be re-pointed at their own speaker row after an identity change, this
is the statement — it just isn't needed for the legacy data:

```sql
update speakers set user_id = '<new-user-id>' where user_id = '<old-user-id>';
```

## After 0014: give every existing word its citation

`0014_upstream_sense_citations.sql` adds `kaikki_senses.entry_id` and the
`upstream_citations` table, but it deliberately backfills **nothing** - a word's
etymology cannot be recovered from its spelling (`kọ́` is three etymologies), so
guessing in SQL would write confident, permanent, sometimes-wrong citations.

Two steps after applying it, in this order:

```
npm run --workspace=ingest run                        # populates entry_id (null until re-ingested)
node scripts/backfillUpstreamCitations.mjs            # dry run: shows exactly what --apply will do
node scripts/backfillUpstreamCitations.mjs --apply --by <curator-email>
```

The backfill links only the words resolving to exactly one etymology, records an
explicit `exempt_reason` for those genuinely absent from Wiktionary, and **leaves
the ambiguous ones untouched** - listed for a curator, and visible as outstanding
because they have no row at all. Re-running it is safe; already-cited words are
reported as such and their `pinned_at` is not restamped.

Until a word is cited, its entry screen says so plainly rather than showing a
volunteer the form-matching diagnosis that predates citations.

## After 0011: the archived pre-merge decisions

`0011_merge_entry_axis.sql` merged the `spelling` and `definition` review axes
into one `entry` axis, and copied every pre-merge row into
**`word_decisions_premerge`** first. That table is both the audit trail for
what the collapse did and the rollback path. Words that had only ONE of the two
axes decided were returned to un-validated (they cannot honestly become an
`entry` row, which asserts both halves were reviewed); they are recoverable
from the archive. The migration `raise notice`s the counts when it runs.

## Design

See `yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md` for the full
reasoning. In short:

- **`golden_record`** + **`golden_record_components`** replace `vocab.json`.
  Components are a real join table (word_id, position, component_word_id),
  not an array column - Postgres arrays can't carry a per-element foreign
  key, so this is what turns the old Python tool's warning-only
  `invalidComponents` check into an actual database constraint.
- **`users`** distinguishes the trusted curator(s) from any other
  authenticated identity - SSO alone doesn't know who's who. Since `0012` it
  is also the **access gate**: any Google account can complete a login, so a
  row here is what makes someone a participant at all, and `users.role` is the
  authoritative source the SWA roles-source function reads (see
  `api/README.md`).
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

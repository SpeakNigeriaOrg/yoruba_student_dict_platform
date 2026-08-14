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

### Production is migrated by hand, and only through the runner

**No CI/CD workflow runs migrations.** Deploying code that needs a new column
does not create it, so a migration has to be applied to production *before* the
code that reads it ships.

Always via `migrate.mjs`, never as raw SQL against production - even for a
one-line `alter table`. Applying a file by hand leaves `schema_migrations`
claiming it was never applied, and because the runner applies pending files **in
order**, the next migration then starts at the unrecorded one, hits an object
that already exists, rolls back and throws. The new migration never runs, and the
error blames the wrong file.

That is not hypothetical: 0014 and 0015 were applied to production by hand during
the Phase H/J deploy and never recorded, so applying 0016 failed on 0014 until
the ledger was reconciled. It was safe to reconcile only because a full
column/index/constraint diff against a fully-migrated database showed 0014 and
0015 had landed *completely* - if any of it had been missing, the fix would have
been to apply the file, not to log it. Verify before backfilling a ledger row.

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

## After 0019: the app asks, and nobody has been asked yet

`0019_contribution_grants.sql` adds `contribution_grants`, the `grant_release_state` function, and
the `speaker_release_rights` and `contributor_release_rights` views. It backfills **nothing**, so
every existing person reads as `release_state = 'unknown'`.

A grant records four things: who, which version of the wording, when, and whether they agreed. It
carried more when first written - separate internal-use and open-release permissions, whether the
instrument assigned or licensed, and an attribution preference on `speakers` - and all of that came
out before it was ever applied anywhere. The terms
(`shared/src/contributorTerms.ts`) assign the copyright in everything created in the portal to Speak
Nigeria outright, so there is no per-person permission left to answer, and Wikimedia Commons carries
crediting in the uploaded file's own metadata rather than in anything here. Columns with one possible
value are furniture, not optionality.

That is not a gap to close in SQL, and mostly it closes itself: the app now asks once, after login
(`app/src/screens/ContributorTerms.tsx`, `POST /api/grants/me`), and records the answer against both
the account and its speaker row. Asked once per **wording version** - `instrument_ref` stores the
version from `shared/src/contributorTerms.ts`, and a changed version asks again, because consent to
v1 is not consent to v2. Editing that wording without bumping `CONTRIBUTOR_TERMS_VERSION` silently
attributes new terms to people who agreed to the old ones.

What the prompt cannot reach is the three legacy speakers, created by the import scripts with
`user_id` null (see the 0012 section above) - which is the database's own record that nobody was
ever asked anything about those 189 recordings. They need an out-of-band row naming the real
instrument (`instrument = 'paid_contract'`, `instrument_ref` pointing at the contract version), or
a `no_grant_reason` row saying why there is none. Writing an acceptance for them would launder an
assumption into a consent someone gave on a date.

Three things follow, all deliberate:

- **Internal pipelines are not gated.** `scripts/exportGameContent.mjs` and
  `scripts/publishToR2.mjs` ignore this table entirely and keep publishing. The teachers were paid
  to record for exactly this use, and taking working audio out of the game to enforce paperwork
  would cost learners something real for no gain in anyone's rights.
- **Writes are gated on a refusal, and only on a refusal.** An account whose effective state is
  `declined` or `revoked` gets a 403 from every non-GET endpoint; it can still read. Enforced once
  in `requireUser` (`api/src/httpAuth.ts`) rather than per handler, so it also covers endpoints
  written later. `unknown` deliberately does **not** block: someone nobody has asked yet is not
  someone who said no, and neither is someone whose grant lookup just failed.
- **External release is gated.** `scripts/exportWiktionaryDrafts.mjs` emits an `{{audio}}` line only
  for a speaker whose `release_state` is `agreed`, and a `{{uxi}}` example only where its
  **author's** is - example text and translations are volunteer writing, and the export publishes
  them. Everything withheld is named per entry with the state that withheld it.

Read the state back through a view, never through the table: the "most recent statement wins,
revoked or not" rule lives there, and `stated_on` (not `granted_on`) is the ordering key precisely
so a refusal - which grants nothing and so had no date - can supersede an earlier acceptance.

There is deliberately **no release log yet**. Nothing has been released, and this repo already has
the cautionary case of a table added ahead of its consumer: `canonical_utterance_selections` has
sat empty since 0001 while the publish scripts hardcode take 1, and this README had to be corrected
for claiming otherwise. The grant is what a release would have to check; the log gets written when
something is actually released.

## After 0018: no backfill, because two of the three fields are already answered

`0018_entry_publication_fields.sql` adds `pos`, `english_gloss` and `etymid_label` to
`golden_record`, and every one of them is an **override**. A cited word's `pos` and glosses are
already in its 0014 pin, and the etymid label is what the `word_id` hint already is - so null means
"read the pin" / "derive it", not "missing".

The population that genuinely needs these is the ~7 words carrying an *exempt* citation, whose pin
is `{}`. They are also the only entries we would ever contribute upstream, which is why the fields
exist at all. `scripts/exportWiktionaryDrafts.mjs --report-only` lists exactly which entries are
still blocked and on which field.

`etymid_label` is not backfilled in SQL on purpose: recovering the hint means stripping
`orthographyInsensitiveForm(display_text)` off the front of the `word_id`, and that function lives
in `shared/` (`etymidLabelFromWordId`). A SQL reimplementation would be the third independent copy
of orthography logic this schema refuses to grow.

## After 0015: the example axis needs no backfill

`0015_word_examples.sql` adds the fourth axis's table and nothing else. No backfill: an
example is one contributor's own work, so there is nothing to recover for words that
predate it - they simply have no examples yet, and the axis shows as outstanding for
everyone until someone gives one.

Two things about it that are deliberate and easy to undo by accident:

- **It is not `utterances`.** That table is a word's PRONUNCIATION, and both
  `scripts/publishToR2.mjs` and `scripts/exportGameContent.mjs` select take-1 utterances
  per word as the audio the game plays. An example is a phrase (`abo adìyẹ`,
  `Ọ̀pọ̀lọ́ ń fò`), so putting it there would feed sentences into the game as single-word
  pronunciations. A test asserts a submission leaves `utterances` untouched.
- **No `word_decisions` row and no fingerprint.** Two volunteers offering different
  examples are not in conflict - they have produced more material. The axis works like
  audio: per contributor, everything kept, `axisDecided.example` meaning "this person has
  given one".

Excluding an example hides it from the collection without deleting the row, the same rule
`0013` applies to contributions.

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
  (and `canonical_image_selections`, 0010) are the deferred acoustic-ML
  canonical-selection algorithm's manual v1 stand-in - a curator would flag a
  best take by hand.

  **They are empty and nothing reads them.** This previously claimed they were
  "what the publish step reads"; that is false. `scripts/publishToR2.mjs` and
  `scripts/exportGameContent.mjs` both hardcode `take_number = 1` for word
  audio and `variant_number = 1` for images, and pick syllable audio by
  first-row-wins with no tiebreak. The key layout they produce
  (`words/{speaker}/{word_id}.wav`, `syllables/{speaker}/{safe_name}.wav`,
  `images/{style}/{word_id}.png`) is built from those hardcoded choices, not
  from a selection table. Note also that the syllable filename is recomputed by
  `safeName()` rather than read from the `legacy_syllable_key` column that
  exists for it.

  Selection is not yet needed for word audio: the two takes per recording
  session are different artifacts by design (take 1 is the whole word, take 2
  carries the syllable segments), so there is one candidate per role. The one
  real gap is the 15 syllables recorded more than once by the same speaker,
  which first-row-wins resolves arbitrarily.

  The consumer is `website-games/public/phonics`, not `syllable_game_concept`,
  which was an early proof of concept and is now empty.

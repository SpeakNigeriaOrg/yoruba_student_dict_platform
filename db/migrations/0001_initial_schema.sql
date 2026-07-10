-- 0001_initial_schema.sql
--
-- Initial schema for the hosted curation platform. Replaces
-- yoruba-student-dict's flat vocab.json/dictionary_overrides.json/local
-- audio files - see that repo's REMOTE_ACCESS_DISCUSSION.md for the full
-- design discussion this implements.
--
-- Two refinements versus that document's original sketch, made while
-- writing the real DDL:
--
--   1. `golden_record_components` is a real join table (word_id,
--      component_position, component_word_id), not a text[] array column.
--      Postgres arrays
--      can't carry a per-element foreign key, so an array column couldn't
--      enforce "every component must reference a real word_id" - exactly
--      the invariant the Python tool only ever WARNED about
--      (invalidComponents in generate_diagnostics.py). A join table turns
--      that warning into a real constraint the database enforces.
--
--   2. `syllable_observations` does NOT denormalize word_id/speaker_id
--      (the original sketch copied them from the parent utterance "to
--      avoid a join"). That's exactly the shape of bug this whole project
--      spent real effort fixing on the Python side - a derived field that
--      can quietly drift from its source of truth (e.g. definitionStatus
--      going stale relative to its override). A join is cheap and never
--      drifts; `syllable_observations_enriched` below is a view, not a
--      copy, for the common query's convenience.

-- On Azure Postgres Flexible Server, pgcrypto must first be added to the
-- server's allowlisted extensions (azure.extensions server parameter, via
-- the Portal or `az postgres flexible-server parameter set`) before this
-- CREATE EXTENSION will succeed - a one-time server-level config step, not
-- part of this migration itself.
create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Identity / roles
-- ---------------------------------------------------------------------

create table users (
  user_id      uuid primary key default gen_random_uuid(),
  email        text not null unique,
  display_name text,
  role         text not null default 'volunteer' check (role in ('curator', 'volunteer')),
  created_at   timestamptz not null default now()
);
-- Looked up by api/GetRoles (the staticwebapp.config.json rolesSource
-- function) against the authenticated user's email - SSO alone only
-- proves who logged in, not that they're the intended curator.

create table speakers (
  speaker_id     uuid primary key default gen_random_uuid(),
  display_name   text not null,
  user_id        uuid references users(user_id), -- nullable: a speaker may have no login of their own
  dialect_region text,                            -- optional, e.g. matches Kaikki's own dialect tags (Ekiti, etc.)
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Vocabulary (replaces vocab.json)
-- ---------------------------------------------------------------------

create table golden_record (
  word_id      text primary key,       -- the existing stable natural key, e.g. "owo_hand"
  display_text text not null,
  syllables    text[] not null,
  definition   text,
  entry_type   text check (entry_type in ('phrase')), -- null = ordinary word, matches vocab.json's "type"
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(user_id)
);

create table golden_record_components (
  word_id           text not null references golden_record(word_id) on delete cascade,
  component_position int not null, -- named to avoid any ambiguity with SQL's POSITION(...) syntax
  component_word_id text not null references golden_record(word_id),
  primary key (word_id, component_position)
);
create index idx_golden_record_components_component on golden_record_components(component_word_id);
-- This index is the reverse index (Python's usedAsComponentOf /
-- build_component_owners_index): "which words list X as a component" is
-- now `select word_id from golden_record_components where component_word_id = X`.

-- An atomic word (no real decomposition) has zero rows here - not a
-- self-referencing row - since the FK-enforced join table makes the old
-- "[self]" placeholder unnecessary; `hasRealComponents` becomes
-- `exists (select 1 from golden_record_components where word_id = ?)`.

-- ---------------------------------------------------------------------
-- Vocabulary review decisions (replaces dictionary_overrides.json)
--
-- Three independent per-word review axes - spelling/tone, definition, and
-- etymology/components - each always resolving to one of: accept Kaikki's
-- version, a human-authored custom override, or (when Kaikki has nothing
-- to compare against) a mandatory custom entry. Deliberately separate from
-- golden_record/golden_record_components: a decision record should never
-- be the only place real content lives - applying a decision that changes
-- content (adopting Kaikki's spelling, accepting a proposed component,
-- writing custom definition text) updates golden_record(_components) in
-- the same transaction that upserts the row here.
-- ---------------------------------------------------------------------

create table word_decisions (
  word_id    text not null references golden_record(word_id) on delete cascade,
  axis       text not null check (axis in ('spelling', 'definition', 'etymology')),
  decision   jsonb not null, -- same field vocabulary as contributions.proposed_value per
                              -- axis (action/candidateForm, definitionAction/definitionText/
                              -- definitionSourceForm, componentsAction/components) - see
                              -- yoruba-student-dict's generate_diagnostics.py for the source
                              -- vocabulary of shapes.
  note       text,
  decided_by uuid not null references users(user_id),
  decided_at timestamptz not null default now(),
  primary key (word_id, axis)
);
-- A freshly-added word (via POST /words or an approved new_entry
-- contribution) starts with zero rows here, exactly like a word added via
-- today's local tool starts absent from dictionary_overrides.json - "which
-- words still need a spelling/definition/etymology decision" becomes
-- `select word_id from golden_record where not exists (select 1 from
-- word_decisions wd where wd.word_id = golden_record.word_id and wd.axis = ?)`.

-- ---------------------------------------------------------------------
-- Assignment and volunteer review queue
-- ---------------------------------------------------------------------

create table assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  word_id       text not null references golden_record(word_id) on delete cascade,
  user_id       uuid not null references users(user_id) on delete cascade,
  assigned_by   uuid references users(user_id),
  assigned_at   timestamptz not null default now(),
  unique (word_id, user_id)
);
create index idx_assignments_user on assignments(user_id);

create table contributions (
  contribution_id uuid primary key default gen_random_uuid(),
  -- Nullable: a 'new_entry' proposal (below) authors a word that doesn't
  -- exist in golden_record yet, so there's no word_id to reference until a
  -- curator approves it and it's actually inserted. Every other axis still
  -- requires a real, already-existing word.
  word_id         text references golden_record(word_id) on delete cascade,
  axis            text not null check (axis in ('spelling', 'definition', 'etymology', 'new_entry')),
  -- Ties word_id's nullability to axis so the two can never drift apart -
  -- 'new_entry' always has a null word_id, every other axis always has a
  -- real one.
  constraint contributions_new_entry_word_id_null
    check ((axis = 'new_entry') = (word_id is null)),
  proposed_value  jsonb not null, -- shape mirrors word_decisions.decision per axis
                                  -- (action/candidateForm, definitionAction/definitionText,
                                  -- componentsAction/components); for 'new_entry', mirrors
                                  -- vocab.json's own entry shape instead (proposedWordId/
                                  -- displayText/syllables/type/components) - see
                                  -- yoruba-student-dict's generate_diagnostics.py for the
                                  -- source vocabulary of the per-axis shapes.
  note            text,
  submitted_by    uuid not null references users(user_id),
  submitted_at    timestamptz not null default now(),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by     uuid references users(user_id),
  reviewed_at     timestamptz
);
create index idx_contributions_word on contributions(word_id);
create index idx_contributions_status on contributions(status);
create index idx_contributions_submitted_by on contributions(submitted_by);

-- ---------------------------------------------------------------------
-- Audio: utterances (whole-word/phrase recordings) and syllable
-- observations (VAD-extracted sub-clips). See REMOTE_ACCESS_DISCUSSION.md
-- - identity for a syllable recording lives here, in the database
-- (syllable_text + its normalized forms), not encoded lossily into a
-- filename the way the local tool's stage_new_recordings.py does, which
-- is why that pipeline silently discards every occurrence of a syllable
-- after the first for a given speaker. Nothing here is ever skipped or
-- overwritten - every take from every speaker is preserved.
-- ---------------------------------------------------------------------

create table utterances (
  utterance_id  uuid primary key default gen_random_uuid(),
  word_id       text not null references golden_record(word_id) on delete cascade,
  speaker_id    uuid not null references speakers(speaker_id),
  take_number   int not null default 1,
  recorded_at   timestamptz not null default now(),
  submitted_by  uuid references users(user_id),
  blob_path     text not null,       -- e.g. utterances/{utterance_id}.wav (post-transcode)
  raw_blob_path text,                -- original upload before transcoding (webm/opus from MediaRecorder)
  duration_s    numeric,
  sample_rate   int,
  status        text not null default 'pending_processing'
                 check (status in ('pending_processing', 'segmented', 'failed', 'flagged_for_review')),
  unique (word_id, speaker_id, take_number)
);
create index idx_utterances_word on utterances(word_id);
create index idx_utterances_speaker on utterances(speaker_id);

create table syllable_observations (
  observation_id      uuid primary key default gen_random_uuid(),
  utterance_id        uuid not null references utterances(utterance_id) on delete cascade,
  syllable_position   int not null,   -- 0-indexed position within the word

  -- Three forms of the same underlying identity, all computed by the app
  -- at insert time via shared/'s ported yoruba_orthography (NOT Postgres
  -- generated columns backed by a separate SQL port of that logic - one
  -- canonical implementation, not a third one drifting independently):
  syllable_text                    text not null, -- exact, diacritics intact, e.g. "kàn"
  syllable_tone_insensitive        text not null, -- tone stripped, underdot kept, e.g. "kan"
  syllable_orthography_insensitive text not null, -- tone AND underdot stripped, e.g. "kan"

  -- The local tool's existing lossy per-speaker filename identity
  -- (generate_syllable_info's safe-name+tone-suffix scheme, e.g.
  -- "kan_low") - kept alongside the real identity above specifically so
  -- the R2 publish step can look up "which recording satisfies this
  -- legacy game-facing slot" without the game needing any changes.
  legacy_syllable_key text not null,

  start_time_s   numeric not null, -- within the parent utterance - discarded today, preserved here
  end_time_s     numeric not null,
  vad_confidence numeric,
  blob_path      text not null      -- e.g. syllables/{observation_id}.wav, opaque
);
create index idx_syllable_obs_utterance on syllable_observations(utterance_id);
create index idx_syllable_obs_exact on syllable_observations(syllable_text);
create index idx_syllable_obs_tone_insensitive on syllable_observations(syllable_tone_insensitive);
create index idx_syllable_obs_ortho_insensitive on syllable_observations(syllable_orthography_insensitive);
create index idx_syllable_obs_legacy_key on syllable_observations(legacy_syllable_key);

-- Convenience view for the common "every recording of syllable X, with
-- which word/speaker it came from" query - a view, not a denormalized
-- column, so it can never go stale:
create view syllable_observations_enriched as
select
  so.*,
  u.word_id,
  u.speaker_id,
  u.take_number
from syllable_observations so
join utterances u on u.utterance_id = so.utterance_id;

-- Example: every recording of "kan" regardless of tone/underdot, across
-- every word and every speaker:
--   select * from syllable_observations_enriched
--   where syllable_orthography_insensitive = 'kan';

-- ---------------------------------------------------------------------
-- Canonical selection - the deferred acoustic ML algorithm's manual v1
-- stand-in (REMOTE_ACCESS_DISCUSSION.md: ship capture + VAD segmentation
-- + a curator "mark as canonical" flag now; the pitch-based selection
-- algorithm is its own later project).
-- ---------------------------------------------------------------------

create table canonical_utterance_selections (
  word_id      text not null references golden_record(word_id) on delete cascade,
  speaker_id   uuid not null references speakers(speaker_id),
  utterance_id uuid not null references utterances(utterance_id),
  selected_by  uuid not null references users(user_id),
  selected_at  timestamptz not null default now(),
  primary key (word_id, speaker_id)
);
-- Publishes to words/{speaker}/{word_id}.wav in R2.

create table canonical_syllable_selections (
  legacy_syllable_key text not null,
  speaker_id          uuid not null references speakers(speaker_id),
  observation_id      uuid not null references syllable_observations(observation_id),
  selected_by         uuid not null references users(user_id),
  selected_at         timestamptz not null default now(),
  primary key (legacy_syllable_key, speaker_id)
);
-- Publishes to syllables/{speaker}/{legacy_syllable_key}.wav in R2 -
-- byte-identical to generate_asset_todo.py/generate_sessions.py's
-- existing expectations, so syllable_game_concept needs no changes.

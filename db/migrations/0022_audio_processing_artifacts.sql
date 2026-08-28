-- Forward-looking delivery processing. Raw capture remains on utterances and
-- syllable_observations; every processing attempt and ready artifact is additive.

create table audio_processing_runs (
  run_id             uuid primary key default gen_random_uuid(),
  processor          text not null,
  processor_version  text not null,
  profile             text not null,
  config              jsonb not null,
  status              text not null default 'running'
                      check (status in ('running', 'completed', 'failed', 'cancelled')),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  error_message       text,
  check ((status = 'running' and finished_at is null) or status <> 'running')
);

create table audio_processing_jobs (
  job_id              uuid primary key default gen_random_uuid(),
  run_id              uuid not null references audio_processing_runs(run_id) on delete cascade,
  utterance_id        uuid references utterances(utterance_id) on delete cascade,
  observation_id      uuid references syllable_observations(observation_id) on delete cascade,
  status              text not null default 'pending'
                      check (status in ('pending', 'running', 'ready', 'rejected', 'failed')),
  attempts            int not null default 0 check (attempts >= 0),
  claimed_at          timestamptz,
  finished_at         timestamptz,
  error_message       text,
  quality_flags       text[] not null default '{}',
  created_at          timestamptz not null default now(),
  check ((utterance_id is not null)::int + (observation_id is not null)::int = 1),
  unique (run_id, utterance_id),
  unique (run_id, observation_id)
);
create index idx_audio_processing_jobs_claim on audio_processing_jobs(status, created_at);

create table audio_artifacts (
  artifact_id         uuid primary key default gen_random_uuid(),
  job_id              uuid not null unique references audio_processing_jobs(job_id) on delete cascade,
  utterance_id        uuid references utterances(utterance_id) on delete cascade,
  observation_id      uuid references syllable_observations(observation_id) on delete cascade,
  purpose             text not null check (purpose in ('game_word', 'game_syllable')),
  profile             text not null,
  source_sha256       text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256     text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  audio_data          bytea not null,
  media_type          text not null default 'audio/wav',
  sample_rate         int not null check (sample_rate > 0),
  duration_s          numeric not null check (duration_s > 0),
  manifest            jsonb not null,
  created_at          timestamptz not null default now(),
  check ((utterance_id is not null)::int + (observation_id is not null)::int = 1),
  unique (purpose, profile, source_sha256, artifact_sha256)
);
create index idx_audio_artifacts_utterance on audio_artifacts(utterance_id) where utterance_id is not null;
create index idx_audio_artifacts_observation on audio_artifacts(observation_id) where observation_id is not null;

-- A selected artifact is a per-speaker game exemplar. `syllable_text` is exact and
-- tone-marked; NFC normalization makes canonically equivalent Unicode spellings one slot.
create table game_syllable_artifact_selections (
  speaker_id          uuid not null references speakers(speaker_id),
  syllable_text       text not null,
  normalized_syllable_text text generated always as (normalize(syllable_text, nfc)) stored,
  profile             text not null,
  artifact_id         uuid not null references audio_artifacts(artifact_id),
  selection_method    text not null check (selection_method in ('curator', 'automatic')),
  selected_by         uuid references users(user_id),
  selected_at         timestamptz not null default now(),
  rationale           jsonb not null default '{}',
  primary key (speaker_id, normalized_syllable_text, profile),
  check ((selection_method = 'curator' and selected_by is not null) or selection_method = 'automatic')
);

comment on table game_syllable_artifact_selections is
  'Preferred per-speaker game exemplars; canonical here is a publication choice, not a claim of one universal Yoruba pronunciation.';

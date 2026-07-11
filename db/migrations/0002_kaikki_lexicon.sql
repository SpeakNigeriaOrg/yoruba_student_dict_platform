-- 0002_kaikki_lexicon.sql
--
-- Queryable home for Kaikki/Wiktionary reference data - replaces the old
-- pipeline's disposable kaikki_lexicon.json (never git-tracked, manually
-- regenerated) with real tables this platform's API can query directly.
-- Populated by ingest/ (this repo), which consumes the canonical
-- normalized artifact published by the kaikki-yoruba repo - see that
-- repo's README, and this repo's approved plan ("Kaikki lexicon" section)
-- for the full design rationale: two sibling projects (this one and
-- yorubadict) had separate, manual, never-automated Kaikki pipelines built
-- from the identical raw extract; kaikki-yoruba is the shared
-- parse+normalize stage, and this migration is where this project's own
-- downstream derivation (componentCandidates, altOfTargets, standardForms,
-- orthography-insensitive indexing) actually lands.
--
-- A separate migration from 0001 - new tables, not a change to existing
-- ones (unlike word_decisions/contributions, which extended 0001's own
-- vocabulary-review concern).

-- ---------------------------------------------------------------------
-- Kaikki reference data
-- ---------------------------------------------------------------------

create table kaikki_senses (
  sense_id                    uuid primary key default gen_random_uuid(),
  pos                         text,
  etymology_number            text,
  headword                    text not null,
  canonical_value             text not null,
  canonical_inference_method  text not null
    check (canonical_inference_method in ('explicit_canonical_tag', 'fallback_headword')),
  canonical_confidence        numeric not null,
  canonical_original_value    text not null,
  standard_forms              text[] not null,
  glosses                     text[] not null,
  alt_of_targets              text[] not null default '{}'
);
create index idx_kaikki_senses_canonical on kaikki_senses(canonical_value);

-- Replaces the old model's "the same sense object is appended to multiple
-- dict keys" (Python/JS object aliasing) with a real join table - a sense
-- is looked up under the orthography-insensitive form of its headword,
-- its canonical form, and (unless it has a dialectal/archaic-tagged
-- sense) every one of its own alternate forms.
create table kaikki_sense_keys (
  sense_id                    uuid not null references kaikki_senses(sense_id) on delete cascade,
  orthography_insensitive_key text not null,
  primary key (sense_id, orthography_insensitive_key)
);
create index idx_kaikki_sense_keys_key on kaikki_sense_keys(orthography_insensitive_key);

create table kaikki_component_candidates (
  sense_id    uuid not null references kaikki_senses(sense_id) on delete cascade,
  position    int not null,
  form        text not null,  -- a candidate SPELLING, not a FK to another
                               -- kaikki_senses row - resolving it to a real
                               -- golden_record word_id still happens
                               -- downstream, per vocab word, exactly like
                               -- today (componentsAxis.ts)
  provenance  text not null check (provenance in ('etymology_template', 'derived_reciprocal')),
  primary key (sense_id, position)
);

-- Lightweight observability, not load-bearing for correctness.
create table kaikki_ingestion_runs (
  run_id            uuid primary key default gen_random_uuid(),
  source_date       date,           -- from the canonical artifact's own metadata.json
  ingested_at       timestamptz not null default now(),
  sense_count       int not null,
  content_hash      text            -- the canonical artifact's own contentHash, for drift detection
);

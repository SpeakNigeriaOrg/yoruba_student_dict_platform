-- Stable freshness key: re-recording reuses an utterance id, so artifact existence alone cannot
-- prove that an artifact was derived from the bytes currently stored as raw provenance.
alter table utterances add column raw_sha256 text check (raw_sha256 ~ '^[0-9a-f]{64}$');
alter table syllable_observations add column raw_sha256 text check (raw_sha256 ~ '^[0-9a-f]{64}$');

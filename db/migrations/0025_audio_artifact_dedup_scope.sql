-- Two recordings may contain identical bytes but still need distinct provenance rows/FKs.
-- Hashes identify content; they must not collapse separate observations into one row.
alter table audio_artifacts
  drop constraint audio_artifacts_purpose_profile_source_sha256_artifact_sha2_key;
create index idx_audio_artifacts_content
  on audio_artifacts(purpose, profile, source_sha256, artifact_sha256);

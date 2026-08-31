-- The browser's native recording is immutable provenance; audio_data is the separately
-- validated PCM-WAV delivery copy. MIME labels are recorded, while byte inspection remains truth.
alter table utterances add column raw_media_type text;
alter table utterances add column raw_container text
  check (raw_container in ('wav', 'webm', 'ogg', 'mp4'));
alter table utterances add column delivery_media_type text not null default 'audio/wav';

alter table syllable_observations add column raw_media_type text;
alter table syllable_observations add column raw_container text
  check (raw_container in ('wav', 'webm', 'ogg', 'mp4'));
alter table syllable_observations add column delivery_media_type text not null default 'audio/wav';

comment on column utterances.raw_media_type is 'Browser-declared type for provenance only; raw_container is detected from bytes.';
comment on column utterances.audio_data is 'Validated PCM-WAV delivery bytes; raw_audio_data retains the native capture.';

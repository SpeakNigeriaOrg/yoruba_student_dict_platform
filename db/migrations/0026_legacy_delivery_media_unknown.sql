-- 0023 cannot truthfully label legacy audio_data as WAV: historical uploads used a .wav
-- logical path even when their bytes were WebM/Opus. Only uploads inspected by the new API
-- (raw_container is populated) and worker outputs have a verified delivery media type.
alter table utterances alter column delivery_media_type drop not null;
alter table utterances alter column delivery_media_type drop default;
update utterances set delivery_media_type = null where raw_container is null;

alter table syllable_observations alter column delivery_media_type drop not null;
alter table syllable_observations alter column delivery_media_type drop default;
update syllable_observations set delivery_media_type = null where raw_container is null;

comment on column utterances.delivery_media_type is
  'Byte-validated delivery media type; NULL for legacy rows whose container was never inspected.';

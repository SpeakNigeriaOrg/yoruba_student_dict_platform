-- Raw-vs-processed audio: `audio_data`/`blob_path` always mean "the
-- current best version to play" (after whatever trimming/normalization
-- has been applied); `raw_audio_data`/`raw_blob_path` mean "exactly as
-- captured/sliced, before any processing" - kept so reprocessing (a
-- better trim, added loudness normalization, etc.) can always be
-- re-derived from the original rather than needing every intermediate
-- pipeline stage preserved as its own row.
--
-- utterances already had an unused raw_blob_path column (0001) with
-- exactly this intent but nothing ever populated it - this migration
-- doesn't change that column, just adds the bytea counterpart.
-- syllable_observations had no raw/processed distinction at all.
--
-- No real trim/normalize logic exists yet (see conversation) - until it
-- does, application code populates raw_audio_data/raw_blob_path with the
-- same content as audio_data/blob_path, so "raw" is never null once a
-- recording exists, and starts genuinely diverging only once real
-- processing is implemented - no further migration needed at that point.
alter table utterances add column raw_audio_data bytea;
alter table syllable_observations add column raw_blob_path text;
alter table syllable_observations add column raw_audio_data bytea;

-- syllable_observations_enriched expands so.* at creation time (same
-- issue 0007 already fixed once for audio_data) - refresh again now that
-- two more columns exist, in the same migration this time so the view
-- never drifts out of sync with the table it wraps.
drop view if exists syllable_observations_enriched;
create view syllable_observations_enriched as
select
  so.*,
  u.word_id,
  u.speaker_id,
  u.take_number
from syllable_observations so
join utterances u on u.utterance_id = so.utterance_id;

-- syllable_observations_enriched (0001_initial_schema.sql) expands
-- `so.*` at view-creation time - it was created before 0005 added
-- syllable_observations.audio_data, so the view was missing that column
-- entirely, and audio_data would land in the middle of the column list
-- (before word_id/speaker_id/take_number), which `create or replace
-- view` rejects (it only allows appending at the very end). Drop and
-- recreate instead - nothing else depends on this view yet (confirmed
-- unused anywhere in api/src before this migration), so this is safe.
drop view if exists syllable_observations_enriched;
create view syllable_observations_enriched as
select
  so.*,
  u.word_id,
  u.speaker_id,
  u.take_number
from syllable_observations so
join utterances u on u.utterance_id = so.utterance_id;

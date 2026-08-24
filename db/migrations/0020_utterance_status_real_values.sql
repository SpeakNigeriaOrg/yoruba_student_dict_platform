-- 0020_utterance_status_real_values.sql
--
-- Drops two utterance statuses that nothing has ever written and nothing has ever read.
--
-- `failed` and `flagged_for_review` were declared in 0001's CHECK constraint for a pipeline
-- that was then deliberately not built: vad-service/ was to segment server-side and mark
-- what it could not handle, and v1 segments client-side instead (see that directory's own
-- README). registerUtterance.ts writes exactly two values - 'segmented' when a submission
-- carries clips, 'pending_processing' when it does not - and no code path has ever written
-- either of these.
--
-- Two statuses that cannot occur are worse than absent. `flagged_for_review` in particular
-- reads as a queue, and vad-service/README.md names its RATE as the trigger for adopting
-- real Silero VAD - a decision that therefore had no data behind it and never could. The
-- signal it was reaching for does exist and is real: syllable_observations.vad_confidence,
-- written per clip by the client segmenter. That is now surfaced per recording on the word
-- dossier and per syllable in the coverage view, so the question can actually be answered
-- from evidence rather than from a flag nobody sets.
--
-- Nothing is migrated, because no row can hold either value. Verified before writing this:
--   select status, count(*) from utterances group by status;
-- returns only 'segmented' and 'pending_processing'.

alter table utterances drop constraint utterances_status_check;

alter table utterances add constraint utterances_status_check
  check (status in ('pending_processing', 'segmented'));

comment on column utterances.status is
  'Whether this take carries syllable clips. ''segmented'' once syllable_observations rows exist for it, ''pending_processing'' otherwise - which is the resting state for every take 1, since a whole-word recording has nothing to segment. Segmentation QUALITY is syllable_observations.vad_confidence, not a status.';

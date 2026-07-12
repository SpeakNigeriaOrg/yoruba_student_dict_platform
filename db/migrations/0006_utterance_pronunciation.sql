-- Speakers sometimes record under a tentative pronunciation (spelling
-- and/or tone marking) that the word later converges on something
-- different from, once a curator makes a final spelling decision. Who
-- recorded (speaker_id) isn't enough context on its own - we also need
-- what pronunciation they were recording, captured independently of
-- golden_record's current (possibly later-revised) values, so a
-- recording's syllable identity is never silently reinterpreted under a
-- pronunciation the speaker never actually said.
--
-- utterances table is empty in production as of this migration (the
-- audio-recording feature has no real usage yet), so these can be added
-- as NOT NULL directly with no backfill needed.
alter table utterances add column recorded_display_text text not null;
alter table utterances add column recorded_syllables text[] not null;

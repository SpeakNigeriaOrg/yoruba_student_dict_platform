-- Short-term storage decision: audio bytes live directly in Postgres
-- (bytea) rather than Azure Blob Storage. Volume is expected to stay
-- small for a long while, and this avoids paying for/operating a second
-- storage service on top of the Postgres SSD already provisioned.
--
-- blob_path stays NOT NULL and keeps its existing path-shaped convention
-- (e.g. utterances/{utterance_id}.wav) even though nothing is actually
-- stored at that path today - it's a logical identifier now, not a real
-- object reference. If/when real volume justifies moving to Blob
-- Storage, the migration path is: upload each row's audio_data to that
-- same blob_path, then null out audio_data - no path scheme changes,
-- no consumer of blob_path needs to change.
alter table utterances add column audio_data bytea;
alter table syllable_observations add column audio_data bytea;

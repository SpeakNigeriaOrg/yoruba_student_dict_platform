-- Parallel branch to word_images (0010_word_images.sql), for short (~5s,
-- 480p) cartoon-style generated video clips - same "any number of variants
-- per word+style" shape (unique(word_id, video_style, variant_number),
-- video_style free text exactly like art_style), but NOT stored inline:
-- video is much larger than a PNG (multi-MB per clip vs. tens of KB), so
-- unlike images/audio there is no bytea column here at all. Bytes live in
-- R2 from day one - videogen/review.py uploads to a staging prefix
-- (staging/videos/{style}/{word_id}/v{n}.mp4) immediately on accept (there
-- is nowhere else to put multi-MB bytes), and publishToR2.mjs promotes
-- (R2-to-R2 copy) the accepted object to its public key
-- (videos/{style}/{word_id}/{variant}.mp4) at actual publish time -
-- preserving the same "accepted into DB != published to the live game"
-- boundary word_images/utterances already have.
create table word_videos (
  video_id       uuid primary key default gen_random_uuid(),
  word_id        text not null references golden_record(word_id) on delete cascade,
  video_style    text not null, -- open-ended like art_style, e.g. 'cartoon'
  variant_number int not null default 1,
  content_type   text not null default 'video/mp4',
  duration_ms    int not null,
  width          int not null,
  height         int not null,
  byte_length    bigint not null,
  blob_key       text not null, -- R2 object key (staging area; promoted at publish time - see above)
  sha256         text not null, -- integrity check + idempotent re-upload detection
  uploaded_by    uuid references users(user_id),
  uploaded_at    timestamptz not null default now(),
  unique (word_id, video_style, variant_number)
);
create index idx_word_videos_word on word_videos(word_id);
create index idx_word_videos_style on word_videos(video_style);

-- No canonical_video_selections: word_images' equivalent table exists but
-- is deliberately unwired (see 0010_word_images.sql) because the export
-- pipeline publishes every accepted variant rather than picking one
-- canonical image, and video follows the same "publish everything
-- accepted" design - there is no single canonical pick to maintain here.

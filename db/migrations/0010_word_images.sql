-- Images, stored the same way audio is (0005_utterance_inline_audio.sql):
-- inline bytea in Postgres, not Blob/R2 - same reasoning, same escape
-- hatch if volume ever justifies moving out (upload image_data to
-- blob_path, then null out image_data; no path scheme changes).
--
-- Mirrors utterances' shape, but the "category" a word can have multiple
-- takes in is art_style (e.g. 'cartoon', 'real'), not speaker_id - there
-- is no per-image "who spoke this" identity, so no speakers join here.
-- variant_number plays take_number's role: more than one image can exist
-- for the same word+style (e.g. two cartoon attempts), exactly like more
-- than one recording can exist for the same word+speaker.
create table word_images (
  image_id       uuid primary key default gen_random_uuid(),
  word_id        text not null references golden_record(word_id) on delete cascade,
  art_style      text not null, -- open-ended like speakers.dialect_region, not a fixed enum -
                                 -- 'cartoon'/'real' today, more styles later without a migration
  variant_number int not null default 1,
  image_data     bytea not null,
  content_type   text not null default 'image/png',
  blob_path      text not null, -- e.g. images/{art_style}/{image_id}.png, logical for now (see above)
  uploaded_by    uuid references users(user_id),
  uploaded_at    timestamptz not null default now(),
  unique (word_id, art_style, variant_number)
);
create index idx_word_images_word on word_images(word_id);
create index idx_word_images_style on word_images(art_style);

-- Canonical pick per word+style, same stand-in role as
-- canonical_utterance_selections plays for audio (0001_initial_schema.sql):
-- a curator "mark as canonical" flag now, not automatic inference. Not
-- wired to any UI yet - no real multi-image ambiguity exists today (every
-- labeled word has exactly one cartoon image), same rationale as audio's
-- canonical tables being unwired until real ambiguity exists.
create table canonical_image_selections (
  word_id     text not null references golden_record(word_id) on delete cascade,
  art_style   text not null,
  image_id    uuid not null references word_images(image_id),
  selected_by uuid not null references users(user_id),
  selected_at timestamptz not null default now(),
  primary key (word_id, art_style)
);

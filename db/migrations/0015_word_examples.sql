-- 0015_word_examples.sql
--
-- The fourth axis: one example of the word in use, with audio.
--
-- ---------------------------------------------------------------------------
-- Why a separate table and not `utterances`
-- ---------------------------------------------------------------------------
-- utterances holds a word's PRONUNCIATION. scripts/publishToR2.mjs and
-- scripts/exportGameContent.mjs both select take-1 utterances per word and ship
-- them as that word's audio in the game. An example recording is a phrase - `abo
-- adìyẹ`, `Ọ̀pọ̀lọ́ ń fò` - and putting it there would silently feed sentences into
-- the game as the pronunciation of single words.
--
-- The separation is also what makes "an example never becomes game audio" checkable
-- rather than a convention someone has to remember: the export queries name
-- `utterances` explicitly and cannot reach this table.
--
-- ---------------------------------------------------------------------------
-- Why no fingerprint, no word_decisions row, and no consensus
-- ---------------------------------------------------------------------------
-- Every other content axis is a claim about one truth, so two contributors either
-- agree or conflict, and shared/src/consensus.ts tallies them. An example is not
-- that. Two volunteers offering different examples for `adìyẹ` are not in conflict -
-- they have produced more material, and a dictionary wants several illustrations.
--
-- So this axis works like AUDIO rather than like entry/etymology: per contributor,
-- everything kept, no curator adjudication, and `axisDecided.example` means "this
-- person has given one" (see api/src/reviewShared.ts's loadAxisDecided).
create table word_examples (
  example_id     uuid primary key default gen_random_uuid(),
  word_id        text not null references golden_record(word_id) on delete cascade,
  submitted_by   uuid not null references users(user_id),

  -- Which of the three kinds this is. Recorded because the first two are derived
  -- TERMS - real Yoruba words that may eventually earn their own dictionary entry,
  -- and which the etymology axis already reasons about (getEtymologyReview's
  -- usedInProposal) - while the third is illustration only. That distinction cannot
  -- be recovered later: `abo adìyẹ` and `the frog hops` are both just multi-word
  -- strings once the type is gone.
  example_type   text not null check (example_type in ('derived_term', 'derived_phrase', 'usage_phrase')),

  -- Diacritics and underdots intact, exactly as the composer produced it. Authored
  -- through the tone grid (app/src/screens/PhraseComposer.tsx), so a contributor
  -- never types a combining mark and cannot store a malformed one.
  example_text   text not null,
  translation    text not null,

  -- Inline, exactly as 0005_utterance_inline_audio.sql does for utterances, and for
  -- the same reason: no Azure Storage account exists yet. Recorded whole at natural
  -- pace and NOT segmented per syllable - segmentation exists to harvest game audio
  -- from a word's pronunciation, which this is not.
  audio_data     bytea not null,

  -- The word's spelling when this example was contributed.
  --
  -- Same discipline as 0006's recorded_display_text on recordings and 0014's citation
  -- pin: an example illustrates the word AS IT WAS SPELLED THEN. A later respelling
  -- (Phase F made tone corrections routine) must not silently reinterpret someone's
  -- example under a spelling they never saw.
  recorded_word_text text not null,

  submitted_at   timestamptz not null default now(),

  -- Exclusion, not deletion - mirroring 0013's treatment of contributions. A curator
  -- can remove something abusive or off-topic from the collection while WHAT SOMEONE
  -- SAID survives. Nothing in this schema ever destroys a contribution.
  excluded_by      uuid references users(user_id) on delete set null,
  excluded_at      timestamptz,
  excluded_reason  text,

  -- One per person per word. Re-doing your own example replaces it (the handler
  -- upserts on this key); it never adds a second or touches anyone else's.
  unique (word_id, submitted_by)
);

create index idx_word_examples_word on word_examples(word_id);
create index idx_word_examples_submitter on word_examples(submitted_by);
-- The axis-status lookup is "does this user have a live example for these words",
-- which is this pair filtered to live rows.
create index idx_word_examples_live on word_examples(submitted_by, word_id) where excluded_at is null;

comment on table word_examples is
  'One example of a word in use per contributor: the phrase, its English translation, and audio at natural pace. Deliberately NOT in utterances - that table is a word''s pronunciation and feeds the game.';
comment on column word_examples.example_type is
  'derived_term (a word built from this one), derived_phrase (a multi-word term), or usage_phrase (an illustrative phrase or sentence). The first two are candidate dictionary entries; the third is illustration.';
comment on column word_examples.recorded_word_text is
  'The word''s display_text when this example was contributed, so a later respelling cannot reinterpret it. Same rule as utterances.recorded_display_text.';

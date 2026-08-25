-- 0021_golden_record_created_at.sql
--
-- When an entry came into existence, so "the batch we added on Tuesday" is a
-- question the database can answer.
--
-- ---------------------------------------------------------------------------
-- updated_at was never a stand-in for this
-- ---------------------------------------------------------------------------
-- golden_record has carried `updated_at` since 0001, and for a word nobody has
-- touched since it was added the two coincide - which is exactly what makes it
-- a trap. Applying an entry decision, renaming a word, or backfilling a
-- publication field all move `updated_at`, so the words that have been worked
-- on hardest are the ones that would look newest. A curator assigning "the
-- words we just added" would get last week's review activity instead.
--
-- Separate column, written once, never touched again.
--
-- ---------------------------------------------------------------------------
-- Backfilling from the authoring vote
-- ---------------------------------------------------------------------------
-- Every path that creates an entry records the author's own vote as a
-- contributions row in the same transaction (handlers/authoringVote.ts), and
-- 0019-era backfillAuthoringVotes.ts cast that vote for the words created
-- before it existed. So the earliest contribution on a word is, for almost all
-- of them, the moment the word was written - a real observation rather than an
-- invented one.
--
-- `least(..., updated_at)` guards the rest. A word whose only contributions are
-- later volunteer submissions would otherwise be dated by that submission and
-- claim to be newer than it is; a word with no contributions at all falls back
-- to updated_at through the coalesce. Both fallbacks can only place a word
-- EARLIER than the truth, which is the safe direction here: a "recently added"
-- browse that omits an old word is right, one that surfaces it is noise.

alter table golden_record add column created_at timestamptz not null default now();

update golden_record gr
set created_at = least(
  coalesce(
    (select min(c.submitted_at) from contributions c where c.word_id = gr.word_id),
    gr.updated_at
  ),
  gr.updated_at
);

-- The browse orders by this and takes the newest N, so the index is read
-- descending. Postgres can scan either direction, but naming it here documents
-- the access pattern the column exists for.
create index idx_golden_record_created_at on golden_record(created_at desc);

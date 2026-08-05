-- 0011_merge_entry_axis.sql
--
-- Merges the 'spelling' and 'definition' review axes into one 'entry' axis.
--
-- Rationale: you cannot separate the spelling of a word from its meaning.
-- Yoruba tone marks and underdots ARE semantic - deciding that owo is
-- really owó rather than owọ́ IS deciding which sense the entry denotes, so
-- a curator confirming a spelling without knowing which gloss they are
-- confirming is not actually validating anything. Splitting the two let a
-- word sit half-validated (spelling blessed, meaning unreviewed), which is
-- the state this migration abolishes.
--
-- Note this partly restores the shape the data already had: the old local
-- tool's dictionary_overrides.json carried action/candidateForm/
-- syllableAction AND definitionAction/definitionText/definitionSourceForm
-- as sibling fields of ONE object per word (see shared/src/types.ts's
-- DiagnoseOverride, which never split them). 0001_initial_schema.sql split
-- them into two rows; this puts them back.
--
-- word_decisions holds CURRENT STATE, contributions holds HISTORY, so the
-- two tables get deliberately different treatment below.

-- ---------------------------------------------------------------------
-- 1. Archive. Nothing here is destroyed - this table is both the audit
--    trail for what the collapse did and the rollback path if the merged
--    shape turns out wrong. Kept as a plain table rather than dropped at
--    the end of the migration precisely because step 3 discards rows.
-- ---------------------------------------------------------------------
create table word_decisions_premerge (
  word_id    text not null,
  axis       text not null,
  decision   jsonb not null,
  note       text,
  decided_by uuid not null,
  decided_at timestamptz not null,
  archived_at timestamptz not null default now(),
  primary key (word_id, axis)
);

insert into word_decisions_premerge (word_id, axis, decision, note, decided_by, decided_at)
select word_id, axis, decision, note, decided_by, decided_at
from word_decisions
where axis in ('spelling', 'definition');

-- ---------------------------------------------------------------------
-- 2. Drop the axis check BEFORE the collapse below, not after it. The
--    original constraint permits only spelling/definition/etymology, so
--    inserting the merged 'entry' rows while it is still in force fails on
--    word_decisions_axis_check. Re-added, narrowed, in step 4 once the
--    legacy rows are gone.
-- ---------------------------------------------------------------------
alter table word_decisions drop constraint word_decisions_axis_check;

-- ---------------------------------------------------------------------
-- 3. Collapse words that have BOTH decisions into a single 'entry' row.
--
--    The jsonb || merge is safe because the two field sets are disjoint:
--    spelling owns action/candidateForm/syllableAction/syllableNote,
--    definition owns definitionAction/definitionText/definitionSourceForm.
--    No key collides, so neither side can silently overwrite the other.
--
--    note/decided_by/decided_at DO collide (each axis had its own), so:
--    notes are concatenated with a label naming which axis wrote which -
--    a curator's spelling note and definition note are different claims
--    and merging them into one anonymous blob would lose that - while
--    decided_at takes the later timestamp and decided_by the curator who
--    owns it, since the merged row's meaning is "this entry was last
--    decided by X at T".
-- ---------------------------------------------------------------------
insert into word_decisions (word_id, axis, decision, note, decided_by, decided_at)
select
  s.word_id,
  'entry',
  s.decision || d.decision,
  case
    when s.note is null and d.note is null then null
    when s.note is null then 'Definition: ' || d.note
    when d.note is null then 'Spelling: ' || s.note
    else 'Spelling: ' || s.note || E'\n' || 'Definition: ' || d.note
  end,
  case when d.decided_at >= s.decided_at then d.decided_by else s.decided_by end,
  greatest(s.decided_at, d.decided_at)
from word_decisions s
join word_decisions d on d.word_id = s.word_id and d.axis = 'definition'
where s.axis = 'spelling';

-- ---------------------------------------------------------------------
-- 4. Discard half-decisions.
--
--    A word with only ONE of the two axes decided must NOT become an
--    'entry' row: that row would assert the whole entry is validated when
--    half of it was never reviewed, which is exactly the failure mode the
--    merge exists to remove. Those words revert to un-validated and get
--    re-validated once, atomically. The rows are already archived in
--    word_decisions_premerge above, so this is a reset, not a deletion.
--
--    Counts are raised as notices so the cost is visible in the migrate
--    output rather than silent.
-- ---------------------------------------------------------------------
do $$
declare
  merged_count    int;
  discarded_words int;
begin
  select count(*) into merged_count from word_decisions where axis = 'entry';

  -- Only rows whose word did NOT get an 'entry' row are actually being
  -- discarded. Counting every remaining spelling/definition row here would
  -- also count the two rows per successfully-merged word (the collapse
  -- inserts, it does not delete), reporting roughly triple the real loss.
  select count(distinct wd.word_id) into discarded_words
  from word_decisions wd
  where wd.axis in ('spelling', 'definition')
    and not exists (
      select 1 from word_decisions e where e.word_id = wd.word_id and e.axis = 'entry'
    );

  raise notice 'merge_entry_axis: collapsed % word(s) into the entry axis', merged_count;
  raise notice 'merge_entry_axis: discarding % half-decided word(s) (archived in word_decisions_premerge) - those words return to un-validated', discarded_words;
end $$;

delete from word_decisions where axis in ('spelling', 'definition');

-- word_decisions is current state, so the constraint narrows (re-added
-- here after step 2 dropped it): the legacy values must not be writable
-- again.
alter table word_decisions add constraint word_decisions_axis_check
  check (axis in ('entry', 'etymology'));

-- ---------------------------------------------------------------------
-- 5. contributions.
--
--    Pending spelling/definition contributions propose a half-decision
--    that is no longer expressible, so they are rejected rather than
--    guessed at - a volunteer's spelling proposal carries no opinion about
--    the definition, and inventing one on their behalf would attribute a
--    claim they never made. They resubmit as one atomic entry proposal.
--
--    Unlike word_decisions the check WIDENS rather than narrows: this
--    table is history, and already-approved/rejected rows must stay
--    readable with the axis value they were actually submitted under.
--    Only 'entry' is ever written going forward.
-- ---------------------------------------------------------------------
do $$
declare
  rejected_count int;
begin
  select count(*) into rejected_count
  from contributions
  where status = 'pending' and axis in ('spelling', 'definition');

  raise notice 'merge_entry_axis: rejecting % pending spelling/definition contribution(s) - resubmit as one entry proposal', rejected_count;
end $$;

update contributions
set status = 'rejected', reviewed_at = now()
where status = 'pending' and axis in ('spelling', 'definition');

alter table contributions drop constraint contributions_axis_check;
alter table contributions add constraint contributions_axis_check
  check (axis in ('entry', 'spelling', 'definition', 'etymology', 'new_entry'));

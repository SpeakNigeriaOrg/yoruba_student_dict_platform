-- 0013_contributions_as_evidence.sql
--
-- Reframes a contribution from a PROPOSAL ADDRESSED TO A CURATOR into a piece
-- of EVIDENCE about a word.
--
-- Under the old model a curator approved or rejected one volunteer at a time,
-- and approving applied that person's proposed_value verbatim as the decision.
-- That asks the wrong question - "is Ada right?" rather than "what is true?" -
-- and it does not scale past a handful of contributors.
--
-- Under the new model contributions accumulate. One is provisionally the
-- truth; several that agree are more strongly so; disagreement is a signal
-- that gets flagged and prioritized for a human. A curator ratifies or
-- overrules the SYNTHESIS, in bulk where the evidence agrees. Their
-- determination is the golden record, and it still lives where it always has:
-- one word_decisions row per (word_id, axis).
--
-- ---------------------------------------------------------------------------
-- Provisional consensus is DERIVED, not stored
-- ---------------------------------------------------------------------------
-- There is deliberately no provisional_decisions table and no
-- word_decisions.status column. Materializing provisional state would change
-- what word_decisions MEANS for every existing reader - the publish scripts'
-- gating, getEtymologyReview's targetSpellingConfirmed lookup,
-- createAssignments' 'incomplete' scope - and would introduce a class of bug
-- where the materialized view and the contributions it summarizes disagree.
--
-- word_decisions therefore keeps its exact current meaning: GOLDEN ONLY.
-- Consensus is computed from these rows on read (shared/src/consensus.ts).
--
-- ---------------------------------------------------------------------------
-- Why resolved_value exists alongside proposed_value
-- ---------------------------------------------------------------------------
-- Agreement cannot be computed by comparing proposed_value, because the same
-- claim has several encodings: `keep_ours` and `select_candidate` naming the
-- form a word already has are identical assertions about content. Both of the
-- two real spelling decisions this database held before 0011 were
-- select_candidate, so comparing actions would have scored identical claims as
-- disagreement.
--
-- So each contribution also stores its OUTCOME - the content state it asserts -
-- resolved ONCE at submission time against the record as the contributor saw
-- it, and never recomputed. `keep_ours` means "whatever it says now"; resolving
-- it later against a record that has since changed would retroactively put
-- words in a volunteer's mouth.
--
-- This is the same discipline 0006_utterance_pronunciation.sql applied to
-- recordings ("a recording's syllable identity is never silently reinterpreted
-- under a pronunciation the speaker never actually said") and that
-- syllable_observations applies by freezing three orthographic forms at insert
-- rather than recomputing them. It is what makes belief preservation an
-- enforced property rather than an intention.

-- ---------------------------------------------------------------------------
-- 1. The frozen outcome.
--
--    Nullable because rows predating this migration have no resolved outcome
--    and cannot be given one honestly - we do not know what the record looked
--    like when they were submitted, and guessing would fabricate a belief.
--    Consensus simply ignores contributions with no fingerprint.
-- ---------------------------------------------------------------------------
alter table contributions add column resolved_value jsonb;
alter table contributions add column value_fingerprint text;

comment on column contributions.resolved_value is
  'The content state this contribution asserts, resolved at submission time against the record as the contributor saw it. WRITE-ONCE - never recompute, or a volunteer''s belief gets reinterpreted under a record they never saw.';
comment on column contributions.value_fingerprint is
  'Normalized comparison key for resolved_value (shared/src/consensus.ts fingerprintOutcome). Equal fingerprints mean two contributors asserted the same thing.';

-- ---------------------------------------------------------------------------
-- 2. Exclusion replaces rejection - as NEW columns, not a rename.
--
--    A contribution is evidence, so it is never "declined" - but spam, abuse,
--    and test data must be removable from the tally WITHOUT deleting the
--    belief.
--
--    reviewed_by/reviewed_at are deliberately KEPT rather than renamed into
--    excluded_by/excluded_at. They record something different and still true:
--    that a curator reviewed this submission under the old per-contribution
--    model. Renaming them would assert that everyone previously reviewed had
--    been excluded, which is false for the approved ones - and conflating two
--    distinct facts into one column is exactly the kind of thing this phase
--    exists to undo. (Found the hard way: the rename left legacy 'approved'
--    rows active while carrying exclusion metadata, violating the constraint
--    added in step 3.)
--
--    New rows never set reviewed_*; it is legacy-only from here.
-- ---------------------------------------------------------------------------
alter table contributions add column excluded_by uuid references users(user_id);
alter table contributions add column excluded_at timestamptz;
alter table contributions add column excluded_reason text;

comment on column contributions.reviewed_by is
  'LEGACY: the curator who approved/rejected this under the pre-0013 per-contribution model. Never set on new rows; see excluded_by.';

-- ---------------------------------------------------------------------------
-- 3. Status now describes a row's standing as evidence, not a verdict on a
--    person's submission.
--
--      active     - counts toward consensus
--      superseded - the same contributor later changed their mind; retained so
--                   the history of what they believed, and when, survives
--      excluded   - set aside by a curator (spam/abuse/test), belief retained
--      applied    - a 'new_entry' proposal a curator accepted, and whose word
--                   now exists in golden_record
--
--    'applied' exists because 'new_entry' is not evidence about an existing
--    word - it is a request to author a new one, so none of the other three
--    describe its terminal state. It is also the only axis a curator still
--    approves individually; entry and etymology are settled by confirming the
--    consensus. reviewed_by/reviewed_at carry who accepted it and when.
--
--    Legacy mapping: 'pending' and 'approved' both became part of the record's
--    evidence, so they map to active. 'rejected' maps to excluded - which is
--    also where 0011 put the pending spelling/definition contributions it
--    could not carry across the axis merge.
-- ---------------------------------------------------------------------------
alter table contributions alter column status drop default;
alter table contributions drop constraint contributions_status_check;

--    A rejected row is carried across as excluded, and its old review actor and
--    timestamp are copied into the new columns so "who set this aside, and
--    when" survives the change of vocabulary. (0011 set status without an
--    actor, so excluded_by may legitimately be null while excluded_at is not.)
update contributions
set status = case status when 'rejected' then 'excluded' else 'active' end,
    excluded_by = case status when 'rejected' then reviewed_by else null end,
    excluded_at = case status when 'rejected' then coalesce(reviewed_at, now()) else null end,
    excluded_reason = case status when 'rejected' then 'rejected under the pre-0013 per-contribution review model' else null end;

alter table contributions add constraint contributions_status_check
  check (status in ('active', 'superseded', 'excluded', 'applied'));
alter table contributions alter column status set default 'active';

-- Exclusion metadata belongs only to excluded rows - a superseded row was set
-- aside by its own author changing their mind, not by a curator's judgement.
alter table contributions add constraint contributions_excluded_fields
  check ((status = 'excluded') or (excluded_by is null and excluded_at is null and excluded_reason is null));

-- ---------------------------------------------------------------------------
-- 4. One live vote per person per axis.
--
--    Partial, so superseded and excluded rows accumulate freely - the
--    constraint bounds how many opinions COUNT, not how many are remembered.
--    Changing your mind therefore supersedes your prior row rather than
--    mutating it, which is what keeps the belief history intact.
--
--    'new_entry' is exempt: word_id is null there, so the index cannot apply,
--    and proposing several distinct new words is legitimate anyway.
--
--    IMPLEMENTATION NOTE, learned by tripping over it: superseding and
--    re-inserting CANNOT be done in one statement. A data-modifying CTE
--      with s as (update ... set status='superseded' ...) insert into ...
--    shares a single snapshot with the main insert, so the index still sees the
--    old row as active and the insert fails on this constraint. Do the update
--    and the insert as two sequential statements inside one transaction
--    (withTransaction in api/src/db.ts).
-- ---------------------------------------------------------------------------
create unique index contributions_one_active_vote_per_user
  on contributions (word_id, axis, submitted_by)
  where status = 'active' and word_id is not null;

-- The tally query's access pattern: every active contribution for a set of
-- words, grouped by axis.
create index idx_contributions_word_axis_status on contributions (word_id, axis, status);

-- ---------------------------------------------------------------------------
-- 5. Golden decisions get a fingerprint too, so post-decision dissent is an
--    equality check rather than a re-derivation.
--
--    Nullable: decisions recorded before this migration have none, and
--    consensus reports those words as plain 'golden' rather than guessing
--    whether later contributions contradict them. No other change to
--    word_decisions - see the header.
-- ---------------------------------------------------------------------------
alter table word_decisions add column value_fingerprint text;

comment on column word_decisions.value_fingerprint is
  'Fingerprint of the decided outcome, for detecting later contributions that contradict it. Null on decisions predating 0013.';

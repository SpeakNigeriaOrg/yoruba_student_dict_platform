-- 0019_contribution_grants.sql
--
-- What a contributor has authorised us to do with their work - recorded as a fact
-- about an agreement, so that a licence can be CHOSEN later rather than assumed now.
--
-- ---------------------------------------------------------------------------
-- A grant is not a licence
-- ---------------------------------------------------------------------------
-- The obvious shape - a `licence` column on utterances - is wrong in both
-- directions. It records a decision nobody has made (nothing has been released
-- under any licence, and Speak Nigeria deliberately has not decided which one),
-- and it still does not record who authorised it. Two different facts, with two
-- different lifetimes:
--
--   the GRANT    what a contributor authorised, on a date, under a named
--                instrument. Per person. Immutable once recorded. This table.
--   the RELEASE  what we later decided to do with one asset - this take, this
--                licence, this destination, this date. Per asset. Only valid if a
--                grant permits it, and for CC, irrevocable once done.
--
-- The release log is deliberately NOT in this migration. Nothing releases anything
-- yet, and db/README.md already records what an empty, unread table costs: the
-- canonical_*_selections tables have sat empty since 0001 while the publish scripts
-- hardcode take 1, and the README had to be corrected for claiming otherwise. The
-- shape below is what a release row would have to check; it gets written when
-- something is actually released.
--
-- ---------------------------------------------------------------------------
-- Contributions, not recordings - because the text is published too
-- ---------------------------------------------------------------------------
-- Audio is the obvious asset and it is not the only one. word_examples holds
-- volunteer-authored example sentences AND their English translations, and
-- scripts/exportWiktionaryDrafts.mjs already emits them as {{uxi}} lines. Those are
-- someone's writing, they are copyrightable, and a grant covering only "recordings"
-- would leave them outside the very thing being contributed.
--
-- So the subject of a grant is a PERSON's contributions, of either kind. Which kind
-- a given grant reaches follows from which subject it names, and needs no column of
-- its own:
--
--   user_id set     everything that account produces - its written contributions,
--                   and the recordings of the speaker row linked to it.
--   speaker_id set  that voice's recordings. A speaker with no login is all that
--                   can be covered this way, and is also all such a speaker can
--                   produce: authoring text requires an account.
--
-- An in-app acceptance sets BOTH, so neither lookup depends on the speakers.user_id
-- link still being in place when the question is asked years later.
--
-- ---------------------------------------------------------------------------
-- Two independent permissions, because they are independently answerable
-- ---------------------------------------------------------------------------
-- Collapsing this into one "is it open" flag loses the case that is actually true
-- today: teachers are PAID to validate and record, so internal use (the games, the
-- classes, whatever we build next) is settled, while onward publication under an
-- irrevocable public licence - one take per word to Wikimedia Commons, say - is a
-- separate question that may be answered later, differently, or per person.
--
--   internal_use_permitted  Speak Nigeria's own use, indefinitely.
--   open_release_permitted  sublicensing to the public under an irrevocable
--                           licence we have not chosen yet. The Commons gate.
--
-- rights_basis records what the instrument DOES, which is what decides whether we
-- may pick a licence at all: 'assigned' (the rights sit with Speak Nigeria, so any
-- later licence is ours to choose) or 'licensed' (the contributor retains them and
-- granted permissions we must stay inside).
--
-- attribution_required is here, but HOW someone is credited is not: that is a
-- preference people change their minds about, and a grant is a statement made on a
-- date. It lives on speakers, below, where it can be edited without rewriting
-- history.
--
-- ---------------------------------------------------------------------------
-- Unknown is a real state, and it must not be silently anything else
-- ---------------------------------------------------------------------------
-- 189 recordings already exist from three speakers, all created by the legacy
-- import scripts with user_id null (db/README.md's own note), which means nobody
-- was asked anything. A default of "permitted" would launder that into consent; a
-- default of "denied" would read as a decision someone made. So the same discipline
-- 0014 applies to citations applies here: a row states a grant XOR explains why
-- there is none, and NO ROW AT ALL means nobody has asked yet. Three states, each
-- distinguishable, none of them a default.
create table contribution_grants (
  grant_id     uuid primary key default gen_random_uuid(),

  -- At least one subject, usually both. See the section above for what each reaches.
  user_id      uuid references users(user_id) on delete cascade,
  speaker_id   uuid references speakers(speaker_id) on delete cascade,
  constraint contribution_grants_has_a_subject
    check (user_id is not null or speaker_id is not null),

  -- How the grant was obtained. 'in_app_acceptance' is the everyday case now that
  -- the app asks once at login; the others exist so a real-world route - a clause in
  -- the teachers' engagement terms, a signed form, a witnessed conversation with
  -- someone who has no account - is recordable rather than forced into the nearest
  -- wrong value.
  instrument   text check (instrument in ('paid_contract', 'signed_form', 'in_app_acceptance', 'witnessed_verbal')),

  -- WHICH VERSION of that instrument, and this is load-bearing rather than
  -- bookkeeping. The app asks once per terms version (shared/src/contributorTerms.ts
  -- holds the current one), so this column is what makes "once" mean once - and what
  -- makes a later re-ask honest, since consent to v1 is not consent to v2. For an
  -- out-of-band instrument it points at the contract version or the file in the
  -- nonprofit's own records. Free text: this points AT the document, it is not a
  -- copy of it.
  instrument_ref text,

  -- The date of the STATEMENT, whatever the statement says - an acceptance, a refusal,
  -- or a contract clause being recorded years after it was signed.
  --
  -- Not `granted_on`, which is what this was first called, and the rename is a bug fix
  -- rather than a tidy-up. A refusal grants nothing, so it had no date to record, so it
  -- sorted behind every dated acceptance in the views below - and a contributor who
  -- accepted and then changed their mind stayed 'open_permitted' forever. Withdrawal has
  -- to be able to win, which means the ordering key must be a property every row has.
  --
  -- Defaulted rather than required so a caller cannot omit it and reintroduce that; set
  -- explicitly when recording an instrument that was agreed on some earlier date.
  stated_on   date not null default current_date,

  rights_basis text check (rights_basis in ('assigned', 'licensed')),
  internal_use_permitted boolean,
  open_release_permitted boolean,
  attribution_required   boolean,

  -- The honest alternative to a grant: we asked, and here is why there is not one. A
  -- contributor who declined at the login prompt; a legacy speaker nobody can reach;
  -- an agreement that predates anyone thinking to write this down.
  no_grant_reason text,

  -- Exactly 0014's cited-XOR-exempt shape, for exactly its reason: a blank must
  -- never be mistakable for work nobody got round to.
  constraint contribution_grants_granted_or_explained
    check ((rights_basis is null) <> (no_grant_reason is null)),

  -- A grant that does not say what it permits is not a grant. Enforced rather than
  -- left to the writer, because a null permission read as false silently denies, and
  -- read as true silently consents.
  constraint contribution_grants_grant_is_complete
    check (
      rights_basis is null
      or (instrument is not null
          and internal_use_permitted is not null
          and open_release_permitted is not null
          and attribution_required is not null)
    ),

  -- Withdrawal. Blocks FUTURE releases and nothing else: a CC licence already
  -- granted to the public cannot be recalled, and pretending otherwise by deleting
  -- the row would destroy the only record of what we are still obliged to honour.
  -- The row stays; the state changes.
  revoked_at     timestamptz,
  revoked_reason text,
  constraint contribution_grants_revocation_has_reason
    check ((revoked_at is null) = (revoked_reason is null)),

  -- Who put the row here. The same person as user_id for a self-acceptance; a
  -- curator for anything recorded on someone else's behalf. instrument says which,
  -- so this needs no second column.
  recorded_by uuid references users(user_id) on delete set null,
  recorded_at timestamptz not null default now()
);
create index idx_contribution_grants_user on contribution_grants(user_id, stated_on desc, recorded_at desc);
create index idx_contribution_grants_speaker on contribution_grants(speaker_id, stated_on desc, recorded_at desc);

comment on table contribution_grants is
  'What each contributor authorised us to do with their recordings and their written contributions, per instrument and date. A row states a grant XOR explains why there is none; no row means nobody has asked. Never a licence - see 0019.';

-- ---------------------------------------------------------------------------
-- Attribution: a preference, so it is mutable and lives on the person
-- ---------------------------------------------------------------------------
-- Commons needs a credit line for anything but CC0, and the name to use is the
-- contributor's to choose and change. attribution_name is nullable because
-- 'anonymous' needs no name and 'real_name' can fall back to display_name.
alter table speakers add column attribution_mode text
  check (attribution_mode in ('real_name', 'pseudonym', 'anonymous'));
alter table speakers add column attribution_name text;

comment on column speakers.attribution_mode is
  'How this speaker wants to be credited if a recording of theirs is ever published. A preference, changeable - unlike the grant, which is a statement made on a date.';

-- ---------------------------------------------------------------------------
-- One definition of what a grant amounts to
-- ---------------------------------------------------------------------------
-- Two views below ask the same question of two different subjects, so the rule that
-- turns a row into an answer is a function rather than a CASE written twice. A
-- second copy is a second thing to keep in step, and this one decides whether
-- someone's voice may be published.
--
-- Takes the columns rather than the row, so it is callable from a left join where
-- there IS no row - which is the 'unknown' branch, and the whole reason the state is
-- not just a boolean.
create function grant_release_state(
  p_grant_id uuid,
  p_revoked_at timestamptz,
  p_no_grant_reason text,
  p_open_release_permitted boolean
) returns text language sql immutable as $$
  select case
    when p_grant_id is null                then 'unknown'
    when p_revoked_at is not null          then 'revoked'
    when p_no_grant_reason is not null     then 'declined'
    when p_open_release_permitted          then 'open_permitted'
    else                                        'internal_only'
  end
$$;

comment on function grant_release_state is
  'A grant row (or its absence) as one label: unknown | declined | revoked | internal_only | open_permitted. The only definition; both rights views call it.';

-- ---------------------------------------------------------------------------
-- The effective grant is the MOST RECENT statement, revoked or not
-- ---------------------------------------------------------------------------
-- Taking the latest LIVE row instead would let a withdrawal expose an older, broader
-- grant underneath it - the exact opposite of what withdrawing means.
--
-- Note this makes a grant cover a person's work as a whole rather than take by take:
-- a later, narrower statement applies to everything they have contributed, not only
-- to what comes after it. That is the right way round for the case that matters - "I
-- want my voice taken down" should reach the recordings that already exist - and it
-- is why an already-executed release has to be logged separately, since that one
-- genuinely cannot be recalled.
--
-- A speaker or user with nothing contributed yet still appears here. "Who have we
-- not asked" is a question about people, not about assets.

create view speaker_release_rights as
select distinct on (s.speaker_id)
  s.speaker_id,
  s.display_name,
  s.attribution_mode,
  s.attribution_name,
  g.grant_id,
  g.rights_basis,
  g.instrument,
  g.instrument_ref,
  g.stated_on,
  g.internal_use_permitted,
  g.open_release_permitted,
  g.attribution_required,
  g.no_grant_reason,
  g.revoked_at,
  g.revoked_reason,
  grant_release_state(g.grant_id, g.revoked_at, g.no_grant_reason, g.open_release_permitted) as release_state
from speakers s
-- Either subject reaches this speaker: a grant naming the voice, or a grant made by
-- the account that voice belongs to. An in-app acceptance sets both and matches
-- twice, which the distinct on collapses.
left join contribution_grants g
  on g.speaker_id = s.speaker_id
  or (s.user_id is not null and g.user_id = s.user_id)
order by s.speaker_id, g.stated_on desc, g.recorded_at desc;

comment on view speaker_release_rights is
  'Each speaker''s effective grant - the most recent statement reaching them, revoked or not - as one release_state. Read this, never contribution_grants directly: the precedence rule lives here.';

create view contributor_release_rights as
select distinct on (u.user_id)
  u.user_id,
  u.email,
  u.display_name,
  g.grant_id,
  g.rights_basis,
  g.instrument,
  g.instrument_ref,
  g.stated_on,
  g.internal_use_permitted,
  g.open_release_permitted,
  g.attribution_required,
  g.no_grant_reason,
  g.revoked_at,
  g.revoked_reason,
  grant_release_state(g.grant_id, g.revoked_at, g.no_grant_reason, g.open_release_permitted) as release_state
from users u
left join contribution_grants g on g.user_id = u.user_id
order by u.user_id, g.stated_on desc, g.recorded_at desc;

comment on view contributor_release_rights is
  'Each account''s effective grant, covering the written contributions it authored (word_examples text and translations, which the Wiktionary export publishes as {{uxi}}). Same precedence rule as speaker_release_rights, via the same function.';

-- ---------------------------------------------------------------------------
-- What this deliberately does NOT gate
-- ---------------------------------------------------------------------------
-- scripts/exportGameContent.mjs and scripts/publishToR2.mjs are internal use of
-- material recorded by paid teachers for exactly this purpose, and they work today.
-- Making them refuse audio until grant rows exist would take working, correct content
-- out of the game to enforce paperwork that has not been done yet - a real cost to
-- learners for no gain in anyone's rights.
--
-- Nor does anything here refuse a WRITE. A contributor who has not answered the
-- prompt, or who declined it, keeps working normally; what they produce is simply not
-- releasable externally until that changes. Consent that is extracted by withholding
-- someone's job is not consent.
--
-- Only EXTERNAL release gates on this, and today that is
-- scripts/exportWiktionaryDrafts.mjs, which refuses to emit an {{audio}} line or a
-- {{uxi}} example whose author has not permitted open release, and says so per entry.
-- That is the point at which paperwork and consequence actually meet.

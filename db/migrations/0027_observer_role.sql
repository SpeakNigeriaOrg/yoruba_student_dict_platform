-- Board members were being made curators so they could see the project: who is
-- volunteering, what is being submitted, how coverage is progressing. That gave
-- oversight by handing out the power to edit the dictionary, to people who have
-- said they do not have the expertise to curate. The role that was wanted is
-- "see everything, change nothing", and it did not exist.
--
-- 'observer' is that role. It is a peer of the existing two rather than a rank
-- above or below them: a volunteer contributes and cannot review, a curator does
-- both, an observer does neither and only reads.
--
-- Enforcement is NOT here. It is httpAuth.ts's requireCurator, which admits an
-- observer only on GET - the same method-is-the-signal rule requireUser already
-- uses for the contributor agreement, kept in one place for the same reason: a
-- per-endpoint check is a dozen files and a permanent invitation to forget one.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('curator', 'volunteer', 'observer'));

comment on column users.role is
  'curator = review and edit; volunteer = contribute only; observer = read-only oversight (board members).';

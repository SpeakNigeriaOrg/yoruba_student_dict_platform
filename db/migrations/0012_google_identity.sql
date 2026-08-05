-- 0012_google_identity.sql
--
-- Moves user identity from GitHub usernames back to email addresses, for
-- Google sign-in.
--
-- This deliberately reverses 0004_users_identify_by_username.sql. That
-- migration was correct for its time: SWA's GitHub provider only ever exposes
-- a username claim (userDetails), never email, and the GitHub registration
-- schema has no login.scopes option to request one - so email-based
-- resolution would have matched zero rows forever.
--
-- What changed is the provider, not the reasoning. Google is registered as a
-- custom OpenID Connect provider (Standard-plan-only, which is also what
-- unblocked the auth.rolesSource function this release restores), and unlike
-- the GitHub provider a custom OIDC registration DOES accept
-- `scopes: [openid, profile, email]`. So an email claim is always present.
-- Email is also the better durable key: a GitHub handle can be renamed by its
-- owner, silently orphaning that person's decisions and assignments.
--
-- CLEAN START, by decision: existing rows are GitHub handles and are NOT
-- mapped to Google addresses. They are left in place rather than deleted, so
-- all ~12 foreign-key references stay valid and no history is destroyed -
-- word_decisions.decided_by, assignments, contributions.submitted_by,
-- speakers.user_id, word_images.uploaded_by, and the rest still resolve. The
-- people behind those rows simply get new user_id values on first Google
-- login, and the old rows become unreachable for sign-in.
--
-- One consequence worth knowing before it surprises someone: AxisDecided.audio
-- is scoped per-user by design (api/src/reviewShared.ts), and speakers.user_id
-- still points at the OLD rows. So a returning volunteer will be shown "not
-- yet recorded" for words they already recorded, and will be asked to record
-- them again. Existing recordings still publish fine (the R2 pipeline joins
-- speakers, not logins). To hand a person their recording history back, remap
-- their speaker rows once, after they have logged in:
--
--   update speakers set user_id = '<new-user-id>' where user_id = '<old-user-id>';

alter table users rename column username to email;

-- Which provider this identity came from, and that provider's own stable
-- subject id. principal.userId was parsed but never persisted before; keeping
-- it makes "same person, changed email address" a recoverable situation
-- rather than a lost account. Nullable because it is only learned at first
-- login, whereas a row is created earlier than that by the curator's invite.
alter table users add column identity_provider text not null default 'google';
alter table users add column provider_subject text;
alter table users add constraint users_provider_subject_unique unique (provider_subject);

-- Case-insensitive uniqueness. Email addresses are not case-sensitive in
-- practice, so the plain unique constraint inherited from 0001 would happily
-- accept Alice@example.com alongside alice@example.com - two accounts for one
-- person, with assignments split between them. Both resolveUser and getRoles
-- match on lower(email) to line up with this index.
alter table users drop constraint users_email_key;
create unique index users_email_lower_unique on users (lower(email));

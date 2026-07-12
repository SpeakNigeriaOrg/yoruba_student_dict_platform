-- 0004_users_identify_by_username.sql
--
-- Real, deployment-blocking bug found while prepping for Azure: confirmed
-- against current Microsoft Learn docs (Authentication-authorization,
-- Custom authentication in Azure Static Web Apps) that SWA's GitHub
-- identity provider - default OR custom-registered via
-- `identityProviders.gitHub` - only ever exposes a username claim
-- (userDetails), never an email claim. The custom-registration schema for
-- GitHub has no `login.scopes` option to request one either (unlike the
-- generic OpenID Connect provider type). Since this platform's login is
-- GitHub (staticwebapp.config.json's `/login` -> `/.auth/login/github`),
-- `users.email`-based identity resolution would never work at all - every
-- authenticated user would permanently resolve to no row, and GetRoles
-- would always return no roles, for anyone, forever.
--
-- Fix: identify users by their GitHub username (SWA's `userDetails`,
-- always present for an authenticated request) instead of an email claim
-- that GitHub's provider will never supply.

alter table users rename column email to username;

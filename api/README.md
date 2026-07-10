# api/

Azure Functions (Node.js v4 programming model, TypeScript) - the write-side
of the platform. Everything here needs server trust; read-only
diagnosis/search stays client-side in `app/` (see its README).

## Status

Scaffolded and partially implemented, verified against a real local
Postgres instance (`npm run test --workspace=api`, 22/22 passing) -
`func`/the Azure Functions Core Tools emulator aren't available in this
development environment, so the actual HTTP-triggered `app.http(...)`
wrappers (`src/functions/*.ts`) are `tsc`-checked but not runtime-tested
end-to-end; the business logic they call (`src/handlers/*.ts`) is the part
that's actually exercised against real data, kept deliberately thin-wrapper
so there's as little untested glue as possible.

Implemented:
- `GET|POST /GetRoles` (`src/functions/getRoles.ts` / `src/handlers/getRoles.ts`)
  - the custom role-source function `staticwebapp.config.json`'s
    `auth.rolesSource` points at. Upserts a `users` row (defaulting to
    `volunteer`) for a not-yet-seen authenticated email, then reports
    `['curator']` or `[]` - SWA's built-in `anonymous`/`authenticated`
    roles are granted automatically regardless of what this returns.
  - **Open verification item**: SWA's documented contract for this
    function's response is a plain JSON array of role strings, not
    verified against a real deployed instance yet.
  - **Open verification item**: resolving identity by email (`users.email`)
    assumes the configured auth provider's claims include an email claim -
    GitHub in particular requires the `user:email` scope be explicitly
    requested for this to be populated. Not something this codebase can
    confirm without a real deployment.
- `POST /words`, `POST /phrases` (`src/functions/words.ts` /
  `src/functions/phrases.ts`, `src/handlers/createWord.ts` /
  `createPhrase.ts`) - curator-gated direct insert into
  `golden_record`(`_components`), per the approved plan's
  "curator-gated authoring" decision. `createPhrase` requires at least one
  component (matching `resolve_server.py`'s actual server-side rule, not
  the stricter "≥2" the old tool's UI alone enforces) and does an existence
  pre-check for a clean error before the `golden_record_components` foreign
  key would otherwise reject it with a raw constraint violation.

Not yet implemented: `POST /decisions/{axis}`, `POST /contributions`,
`POST /contributions/{id}/approve`, `POST /utterances/sas-token`,
`POST /utterances/register`, `GET /assignments/me` - these are next.

## Structure

- `src/db.ts` - a lazily-created `pg.Pool` per Functions host instance, plus
  `withTransaction` (used by any handler writing more than one row).
  Handlers are written against a minimal `Queryable` interface (satisfied
  by both `pg.Pool` and `pg.PoolClient`), not `pg.Pool` directly - lets
  tests pass a single connection instead.
- `src/auth.ts` - framework-agnostic parsing of the `x-ms-client-principal`
  header SWA injects, plus the `users` table lookup. Deliberately has no
  dependency on `@azure/functions` so it's unit-testable without
  constructing a real `HttpRequest` (see `src/auth.test.ts`).
- `src/httpAuth.ts` - the thin HTTP-layer glue (`requireUser`/
  `requireCurator`) that extracts the header from a real `HttpRequest` and
  re-checks the caller's role against the database - never trusts SWA's
  own injected `userRoles` blindly, matching this repo's general
  "check again server-side" principle (e.g. Add Phrase's strict
  component check is enforced server-side too, not just in the UI).
- `src/handlers/*.ts` - the actual business logic, framework-agnostic
  (no `@azure/functions` imports), tested against real local Postgres.
- `src/functions/*.ts` - thin `app.http(...)` registrations: parse the
  request, call a handler, map its result/errors to an HTTP response.
- `src/testSupport.ts` - test-only helpers (not imported by non-test code).
  Vitest runs test files concurrently by default, and they all share this
  one real database, so cleanup is scoped by a per-file namespace prefix
  (e.g. `testcw_` for `createWord.test.ts`) rather than one global pattern
  - two files racing to clean up the same broad pattern is exactly what
  caused real cross-file test failures the first time this was written
  with a single shared `test_` prefix.

## Local development

`cp local.settings.json.example local.settings.json` and point
`DATABASE_URL` at a local Postgres instance with `db/migrations` applied.
`npm run test --workspace=api` needs `DATABASE_URL` exported in the shell
too (Vitest doesn't read `local.settings.json`). `npm run start` (`func
start`) requires the Azure Functions Core Tools, not installed in this
environment.

Imports `@yoruba-student-dict-platform/shared` for server-side validation
of incoming writes once the decision/contribution endpoints need it (e.g.
confirming a submitted component word_id actually exists, or reusing the
same tone/orthography normalization the client already ran) - never
duplicates logic that already lives there.

# api/

Azure Functions (Node.js v4 programming model, TypeScript) - the write-side
of the platform. Everything here needs server trust; read-only
diagnosis/search stays client-side in `app/` (see its README).

## Status

Scaffolded and partially implemented, verified against a real local
Postgres instance (`npm run test --workspace=api`, 53/53 passing) -
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
- `POST /decisions/{axis}` (`src/functions/decisions.ts`,
  `src/handlers/applySpellingDecision.ts` / `applyDefinitionDecision.ts` /
  `applyEtymologyDecision.ts`) - a curator's direct decision on one of the
  three review axes. Every axis applies its content change (if any) and
  upserts `word_decisions` in one transaction - re-deciding an axis
  overwrites the previous row rather than accumulating history.
  - `definition` and `etymology` are fully self-contained: `custom`
    definition text is human-authored, and `accept_proposed`/`custom`
    components are word_ids the client already resolved against its own
    held copy of the Kaikki lexicon (validated here exactly like
    `createPhrase`'s existence check).
  - `spelling` bundles the syllable-split sub-decision
    (`syllableAction`/`syllableNote`) alongside the main Kaikki-comparison
    decision, mirroring how a single `dictionary_overrides.json[wordId]`
    entry carries both as sibling fields in the old tool.
    `accept_programmatic` recomputes syllables from whichever spelling is
    *effective* after this same call (the new one, if `adopt_kaikki` is
    also happening) - same rationale as `resolveEffectiveDisplayText`.
  - **Known gap**: `adopt_kaikki` requires the caller to supply
    `newDisplayText` directly rather than this handler re-deriving it from
    the Kaikki lexicon itself. The Function app has no established way to
    load the (multi-MB) lexicon at runtime yet - revisit once that's
    decided; see the comment at the top of `applySpellingDecision.ts`.

- `POST /contributions` (`src/functions/contributions.ts`,
  `src/handlers/submitContribution.ts`) - any authenticated user proposes a
  decision on an existing word's axis, or (`axis: 'new_entry'`) a brand-new
  word/phrase. Purely records a pending row; nothing is applied until a
  curator approves it. `decisionInputParsing.ts` holds the per-axis
  request-body validation shared with `POST /decisions/{axis}`, since a
  contribution's `proposed_value` is exactly "the decision, not yet
  applied" - identical shape either way.
- `POST /contributions/{id}/approve` (`src/functions/approveContribution.ts`,
  `src/handlers/approveContribution.ts`) - curator-only. Applies a pending
  contribution exactly like the curator's own direct decision would, by
  composing the *same* `apply*DecisionInTransaction`/`createWord`/
  `createPhraseInTransaction` functions the direct-decision endpoints use
  - each handler now exports both a `pg.Pool`-based entry point (opens its
  own transaction) and a `Queryable`-based `*InTransaction` variant (for
  composing into a larger one). Everything - reading and locking the
  contribution row (`for update`, so two concurrent approvals of the same
  contribution can't both apply it), the content change, and marking the
  contribution `approved` - happens in one transaction, so a contribution
  can never end up applied-but-still-pending or approved-but-never-applied.
  Confirmed by test: a `new_entry` phrase contribution with a bad
  component reference rolls back cleanly and the contribution stays
  `pending`, not stuck half-applied.

Not yet implemented: `POST /utterances/sas-token`, `POST /utterances/register`,
`GET /assignments/me` - these are next. The audio endpoints in particular
need a real Azure Storage account to test the SAS-token flow against,
which doesn't exist yet.

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
  `handlers/errors.ts` holds error classes genuinely shared across
  handlers (`WordNotFoundError`, `WordIdAlreadyExistsError` - the latter
  started out duplicated identically in `createWord.ts`/`createPhrase.ts`
  until `approveContribution.ts` needed to compose both and catch/
  attribute the same error regardless of which path a `new_entry`
  contribution's type took).
- `src/decisionInputParsing.ts` - per-axis request-body validation shared
  by `functions/decisions.ts` and `functions/contributions.ts`.
- `src/functions/*.ts` - thin `app.http(...)` registrations: parse the
  request, call a handler, map its result/errors to an HTTP response.
- `src/testSupport.ts` - test-only helpers (not imported by non-test code).
  Vitest runs test files concurrently by default, and they all share this
  one real database, so cleanup is scoped by a per-file namespace prefix
  (e.g. `testcw_` for `createWord.test.ts`) rather than one global pattern
  - two files racing to clean up the same broad pattern is exactly what
  caused real cross-file test failures the first time this was written
  with a single shared `test_` prefix. `cleanUpTestData` also explicitly
  cleans up `contributions` rows (matched by `word_id` OR by
  `submitted_by`/`reviewed_by`) before deleting `users` - a `new_entry`
  contribution's `word_id` is null, so `golden_record`'s own
  `ON DELETE CASCADE` never reaches it, and `contributions.submitted_by`
  has no cascade either, which surfaced as a real FK-violation failure the
  first time contribution tests ran.

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

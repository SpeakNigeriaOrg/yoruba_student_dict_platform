# api/

Azure Functions (Node.js v4 programming model, TypeScript) - the write-side
of the platform. Everything here needs server trust; read-only
diagnosis/search stays client-side in `app/` (see its README).

## Status

Scaffolded and partially implemented, verified against a real local
Postgres instance (`npm run test --workspace=api`, 56/56 passing) -
`func`/the Azure Functions Core Tools emulator aren't available in this
development environment, so the actual HTTP-triggered `app.http(...)`
wrappers (`src/functions/*.ts`) are `tsc`-checked but not runtime-tested
end-to-end; the business logic they call (`src/handlers/*.ts`) is the part
that's actually exercised against real data, kept deliberately thin-wrapper
so there's as little untested glue as possible.

## Authentication and roles

**Provider: Google only**, registered as a custom OpenID Connect provider in
`app/public/staticwebapp.config.json`. This requires the **Standard** plan -
the `auth` block is Standard-SKU-only, confirmed earlier by a real deployment
rejection on Free ("The 'auth' configuration in staticwebapp.config.json is
only supported on the Standard SKU"). The same upgrade is what re-enabled the
`auth.rolesSource` function that commit `d4d9599` had to delete.

The default providers are explicitly 404'd (`/.auth/login/github`, `aad`,
`twitter`) so `/login` is the only way in.

**Identity is resolved by email** (`users.email`), reversing
`0004_users_identify_by_username.sql`. That migration switched to GitHub
usernames because SWA's GitHub provider only ever exposes a `userDetails`
username claim and its registration schema cannot request an email scope.
A *custom OIDC* registration can - `scopes: [openid, profile, email]` plus a
`nameClaimType` of the emailaddress claim - so `userDetails` is now the email.
Email is also the better durable key: a GitHub handle can be renamed by its
owner, silently orphaning that person's decisions and assignments.

**Roles are database-driven, and the database is authoritative.** This is the
reverse of the previous arrangement:

| | Before (Free plan) | Now (Standard) |
|---|---|---|
| Role source of truth | Azure Portal invite, mirrored into `users.role` | `users.role` |
| Sync direction | `principal.userRoles` overwrote the DB every request | `handlers/getRoles.ts` reads the DB |
| Changing a role | Azure Portal -> Role management | `PATCH /api/users/{userId}`, from the Users screen |

`auth.ts`'s `resolveUser` is now a **lookup, not an upsert**. It returns null
for an email with no `users` row, which `httpAuth.ts` turns into a 401, and it
never writes. `principal.userRoles` is not consulted for role at all - a stale
or forged token claiming `curator` does not confer it.

**Access is gated on pre-registration.** Any Google account can complete a
login, so `authenticated` cannot mean "allowed". `handlers/getRoles.ts` grants
a custom **`member`** role only to emails that already have a `users` row
(plus `curator` when `users.role = 'curator'`), and every `/api/*` route rule
requires `member` or `curator` rather than `authenticated`. An unregistered
user can sign in to Google and reach nothing. Curators register people by
email via `POST /api/users`.

### Route rule ordering is load-bearing

**A specific route must precede its own wildcard** in
`staticwebapp.config.json`. SWA evaluates `routes` in order, first match wins,
and its `*` matches the bare path as well as paths beneath it.

This was a live 403: `/api/contributions/*` (curator-only) sat above
`/api/contributions` POST (member), so a volunteer submitting a contribution
matched the curator wildcard and was refused. It was invisible for two reasons
worth remembering — `member` worked on every other route, so it read as an auth
bug rather than an ordering one; and unauthenticated probing cannot detect it at
all, because every rule returns the same `401 -> /login` override to an
anonymous caller. Only a real non-curator signing in exposes it.

JSON has no comments, so the invariant lives here. To check it after editing
routes:

```
python3 -c "
import json; rules=[r for r in json.load(open('app/public/staticwebapp.config.json'))['routes'] if r.get('route','').startswith('/api')]
print([(w['route'],s['route']) for i,w in enumerate(rules) if w['route'].endswith('/*')
       for j,s in enumerate(rules) if j>i and (s['route']==w['route'][:-2] or s['route'].startswith(w['route'][:-2]+'/'))] or 'OK')
"
```

Two things about the roles function that are easy to get wrong:

- **Do not add an `allowedRoles` route rule for `/api/GetRoles`.** Verified
  against current Microsoft docs: a `rolesSource` endpoint protected by
  `allowedRoles` is silently **skipped** by SWA - no browser error, no
  function log - leaving every user with no custom roles and therefore no
  access at all. The official sample app has no route rule for it either.
- It cannot use `requireUser`/`requireCurator`: there is no
  `x-ms-client-principal` header yet, since the principal is what the call is
  helping to build. The identity arrives in the request **body**.

Function-based role management is a **preview** feature.

Role changes take effect on the user's **next sign-in**, because SWA caches
the roles it got from the roles function into the session token. Server-side
`requireCurator` re-reads the database on every request, so a demoted curator
loses API access as soon as their token refreshes and cannot act as a curator
server-side even while a stale token claims it.

### First-curator bootstrap

Pre-registration is curator-only, so with no curators there is no way to
create the first one through the app. Insert it once by hand (see also
`db/README.md`):

```sql
insert into users (email, display_name, role)
values ('admin@speaknigeria.org', 'Admin', 'curator');
```

### Deployment checklist (out-of-repo, not in version control)

1. Upgrade the SWA to Standard:
   `az staticwebapp update --name mango-river-070b8550f --sku Standard`
2. Create a Google Cloud OAuth 2.0 **Web application** client. Authorized
   redirect URI: `https://<swa-hostname>/.auth/login/google/callback`.
3. Add SWA application settings `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. The config references them by *setting name*, never
   by value.
4. Bootstrap the first curator (above).

Implemented:
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
- `GET /assignments/me` (`src/functions/assignmentsMe.ts`,
  `src/handlers/listMyAssignments.ts`) - any authenticated user; the
  calling user's assigned word_id batch, joined with `golden_record` for
  the fields a "my assignments" screen needs.
- `GET /assignments/{userId}`, `POST /assignments`, `DELETE
  /assignments/{userId}/{wordId}` (`src/functions/assignments.ts`) -
  curator-only. The bulk admin view: one user's assigned words plus
  per-axis `reviewStatus` (`not_started`/`in_review`/`passed`, computed at
  query time from `word_decisions` + `contributions` - see
  `reviewShared.ts`'s `loadReviewStatusBatch`, no new schema needed),
  assigning word(s) to a user (`ON CONFLICT DO NOTHING`, since
  re-submitting an overlapping list is expected, not exceptional), and
  unassigning one word.
- `GET /users`, `POST /users`, `PATCH /users/{userId}`
  (`src/functions/users.ts`) - curator-only. Every user account plus
  assigned/in-review/passed summary counts; registering a user by Google
  email (the access gate - see the Authentication section); and
  promote/demote, which refuses to demote the last curator so the platform
  can't be locked out of its own administration.
- `POST /GetRoles` (`src/functions/getRoles.ts`) - **called by the SWA
  platform, not the browser.** See the Authentication section for the two
  constraints that are easy to break.

Not yet implemented: `POST /utterances/sas-token`, `POST /utterances/register`
- these need a real Azure Storage account to test the SAS-token flow
against, which doesn't exist yet.

## An entry IS a Wiktionary etymology

A student dictionary entry is one Wiktionary etymology (Etymology 1, 2, …) plus
two local overrides. A spelling is **not** an identity: `kọ́` is three separate
etymologies in our own corpus - a negation particle, "to build/learn", and "to
hang/suspend" - all with `canonical_value = 'kọ́'`.

The two overrides are different in kind, and the UI must not blur them:

| Override | Default | A change means |
|---|---|---|
| spelling | the etymology's canonical form | a **correction** - the other spelling is wrong |
| student definition | seeded from the etymology's glosses | a **pedagogical simplification** - it says nothing against upstream |

Three invariants hold this up:

1. **The citation is captured at creation, never derived later.** Adding a word
   *is* choosing an etymology - the Add Word screen searches Kaikki and a human
   picks one. `CreateWordInput.citation` is required at the type level for that
   reason. Recovering it afterwards from the spelling is impossible, which is why
   `backfillCitations.ts` reports the ambiguous legacy words instead of guessing.
2. **The client sends an id; the server builds the pin.** `upstream_citations.pin`
   is this database's own copy of the cited etymology, taken at validation time.
   A client-supplied pin could carry content that never existed upstream, and
   drift detection trusts the pin as "what upstream said" - so it is built in
   `writeCitationInTransaction`, from the corpus, inside the caller's transaction.
3. **Gloss ORDER is not drift.** kaikki-yoruba names an entry by its *first*
   sense's id, and 20.7% of entries have several senses. Reordering senses inside
   one etymology therefore moves our cited id while changing nothing about what
   the etymology means, so `pinContentFingerprint` compares glosses as a **set**.
   Because the id is content-derived, the branch that fires in practice is
   `re_identified` (the link breaks loudly), not "stable id, changed content".

Every `golden_record` row has an `upstream_citations` row - cited, or explicitly
exempt with a reason. Phrases are recorded exempt by `createPhrase.ts` rather than
left blank, so "no citation row" means exactly one thing: not done.

Two scripts, both safe to run read-only first:

```
node scripts/backfillUpstreamCitations.mjs            # dry run (default)
node scripts/backfillUpstreamCitations.mjs --apply --by admin@speaknigeria.org
node scripts/generateEntryReviewFixtures.mjs          # regenerates app fixtures
```

`exportGameContent.mjs` and `publishToR2.mjs` report citation health before
writing anything, and **warn rather than drop** - our spelling and definition are
human-validated and stay publishable when Wiktionary copy-edits a gloss. Pass
`--strict-upstream` to make drift a hard stop instead.

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
  component check is enforced server-side too, not just in the UI). This
  paragraph used to be aspirational rather than true: `resolveUser` was
  overwriting `users.role` *from* `userRoles` on every request, so SWA's
  injected roles were in fact authoritative. Since the move to DB-driven
  roles it describes the actual behaviour.
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
of incoming writes (e.g. `applySpellingDecision.ts`'s use of
`syllabifyWord`) - never duplicates logic that already lives there. `shared`
resolves via its compiled `dist/`, not live source (see `shared/README.md`
for why - a real runtime bug was found and fixed here), so a `shared/src`
edit needs `npm run build --workspace=shared` before this package's tests
see it; prefer the root `npm run test:api`/`build:api` scripts, which do
this automatically.

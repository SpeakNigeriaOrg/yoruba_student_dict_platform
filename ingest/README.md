# ingest/

This platform's own downstream derivation over the canonical artifact
published by [`kaikki-yoruba`](https://github.com/SpeakNigeriaOrg/kaikki-yoruba)
- reads `entries.json` (one normalized entry per Kaikki record, see that
repo's README), derives this project's specific needs
(`componentCandidates`, `altOfTargets`, `standardForms`, orthography-
insensitive lookup keys) the same way `yoruba-student-dict`'s
`generate_kaikki_lexicon.py` always has, and writes the result into
Postgres (`db/migrations/0002_kaikki_lexicon.sql`) - replacing that
script's disposable, never-git-tracked `kaikki_lexicon.json` with real,
queryable tables `/api` can use directly (see the approved plan's "Kaikki
lexicon" section for the full rationale).

## Pipeline

```
kaikki-yoruba's entries.json
  -> deriveSenses.ts               (per-entry: standardForms, glosses,
                                     componentCandidates (forward-only),
                                     altOfTargets, index keys)
  -> synthesizeComponentReciprocals.ts  (cross-entry: adds the reverse
                                     "part -> compound" direction Kaikki's
                                     etymology templates never give)
  -> writeToPostgres.ts            (truncate + bulk insert, one transaction)
```

`npm run run` (`src/run.ts`) orchestrates all three steps, loading either
the latest `kaikki-yoruba` GitHub Release (default) or a local file
(`node dist/run.js path/to/entries.json [path/to/metadata.json]`, for
testing).

## Status

Verified end-to-end against the real corpus (not just unit tests): ran the
full pipeline against `kaikki-yoruba`'s real published artifact (6,272
entries) into local Postgres - 6,272 senses, 8,514 lookup keys, 3,224
component candidates (2,810 from real etymology templates, 414 from
reciprocal synthesis) landed correctly. 29/29 unit/integration tests
passing (`npm run test`), including tests that exercise ragged (different-
length) array columns and multi-batch inserts (>500 rows) against real
local Postgres.

**Parity-checked against `generate_kaikki_lexicon.py`'s real output** - not
just "my own tests pass," but independent verification against the
established, working Python implementation this ports from. Ran both
pipelines against the *identical* source file
(`yoruba-student-dict/dictionary-Yoruba.jsonl`, to rule out data-drift
between kaikki.org fetches as a confound) and compared every field for
every matched sense: **5,500/5,500 lookup keys matched exactly, and
8,463 of 8,464 comparable senses had identical `standardForms`/`glosses`/
`altOfTargets`/`componentCandidates`.** The one discrepancy
(`gọlọmiṣọ`, etymology 2 vs 3) is a genuine **upstream Kaikki data
quirk** - two structurally different dictionary records were assigned the
*identical* sense id (`en-gọlọmiṣọ-yo-noun-Omx-GUFt1`) by the extraction
itself, and since the canonical artifact is keyed by that id
(`Object.fromEntries`), the later record silently overwrites the earlier
one - inherited from `kaikki-yoruba`'s (and originally `yorubadict`'s) own
id-keying, not a bug introduced by this port. This is the same root cause
behind the earlier-noticed "6,273 records -> 6,272 entries" gap in the
canonical artifact generally. Affects roughly 1 in 6,273 records; not
fixed here since it's upstream of this project's own code - worth flagging
to `kaikki-yoruba` as a known limitation if it ever becomes a real problem
in practice.

**Real bug found and fixed along the way** (in `shared/`, not `ingest/`
itself, but discovered while building this): `@yoruba-student-dict-
platform/shared`'s `package.json` pointed `main`/`types` directly at raw
`.ts` source, and several of its own internal relative imports lacked
`.js` extensions - both fine for Vitest (which transpiles TS and tolerates
extensionless imports) but **fundamentally broken under plain Node
execution**, which is what `/api`'s real Azure Functions deployment (and
this package's own `npm run run`) actually needs. Confirmed the failure
mode, fixed both issues (extensions added throughout `shared/src`,
`package.json` now points at compiled `dist/`), and confirmed
`api/dist/handlers/applySpellingDecision.js` - which imports
`syllabifyWord` from `shared` - now actually loads under plain Node.
Consuming packages (`api/`, `ingest/`) now rebuild `shared` first via the
root `test:api`/`test:ingest`/`build:api`/`build:ingest` scripts, since
Vitest/Node now resolve `shared` via its compiled output rather than
live source - a real (if minor) dev-ergonomics cost worth knowing about:
a `shared/src` edit needs `npm run build:shared` before a dependent
package's tests will see it.

**Not yet done:**
- No scheduled automation of this pipeline yet (unlike `kaikki-yoruba`'s
  own weekly GitHub Actions refresh) - `npm run run` needs to be triggered
  manually, or wired into a scheduled job of its own once this platform
  has real Azure infrastructure to run it against.
- The eventual `api/src/kaikkiLookup.ts` (targeted queries against these
  tables to close `applySpellingDecision.ts`'s `adopt_kaikki` verification
  gap) hasn't been built yet - this ingestion step is the prerequisite for
  it, now done.
- Running `npm run test --workspace=ingest` truncates the `kaikki_*`
  tables as part of its own test setup/teardown - if you've just run a
  real ingestion locally and want to keep that data, re-run `npm run run`
  after running tests, not before.

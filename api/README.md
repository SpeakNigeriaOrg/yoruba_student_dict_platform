# api/

Azure Functions (Node.js v4 programming model, TypeScript) - the write-side
of the platform. Everything here needs server trust; read-only
diagnosis/search stays client-side in `app/` (see its README).

Planned endpoints (see repo root README and
`yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md` §2 for the full design):

- `POST /decisions` - curator saves a spelling/definition/etymology
  decision, direct to `Golden_Record`. Curator role only.
- `POST /contributions` - a volunteer's suggestion, into `Contributions`
  (never touches `Golden_Record` directly). Any authenticated user.
- `POST /contributions/{id}/approve` - curator applies a pending
  contribution into `Golden_Record`. Curator role only.
- `POST /uploads/sas-token` - issues a short-lived Blob Storage SAS token
  for direct client-to-Blob upload. Any authenticated user. A browser can
  never hold Azure Storage account credentials, so this exists regardless
  of where audio segmentation happens (see `app/`'s README - v1 segments
  client-side, no `vad-service`/Container App).
- `POST /utterances/register` - called after the client has already
  uploaded whole-word/syllable clips directly to Blob Storage via the SAS
  token above; writes the `Utterances`/`SyllableObservations` rows. This is
  also where `syllable_text` gets normalized into its indexed tone/
  orthography-insensitive forms and legacy R2-compatible key via `shared/`'s
  ported orthography logic - one canonical place for that computation
  regardless of where segmentation ran.
- `GET /assignments/me` - the calling user's assigned word_id batch.
- `GET|POST /GetRoles` - the custom role-source function
  `staticwebapp.config.json` points `auth.rolesSource` at. Looks up the
  authenticated identity (from the `x-ms-client-principal` header SWA
  injects) against the `Users` table and returns its role(s) - this is what
  actually makes the `curator` vs `authenticated` role distinction real,
  since SSO alone only proves *who* logged in, not that they're the
  intended curator.

Imports `shared/` for server-side validation of incoming writes (e.g.
confirming a submitted component word_id actually exists) - never
duplicates logic that already lives there.

Not yet scaffolded with actual Azure Functions tooling - placeholder
pending the first real implementation pass.

# app/

React (Vite + TypeScript) frontend, deployed to Azure Static Web Apps.

Responsibilities (see the repo root README and
`yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md` for the full design):

- Fetch the vocabulary/diagnostics data and run `shared/`'s matching engine
  client-side for live preview/search - no Azure Function round-trip needed
  for read-only operations, since that logic is pure and doesn't require
  server trust.
- Three curator-facing review surfaces (mirroring the local tool's three
  tabs: Definitions, Spelling & Tone, Etymology), plus new screens not in
  the local tool: an audio recorder (`MediaRecorder` API → uploads to
  `api/`), a per-user assignment view ("mine" / "unassigned pool" /
  "everything" for the curator role), and a volunteer-contribution review
  queue.
- Login via Azure SWA's built-in auth (EasyAuth); role-gated views driven by
  the `x-ms-client-principal` identity SWA injects.

Not yet scaffolded with actual Vite tooling - this is a placeholder pending
the first real implementation pass.

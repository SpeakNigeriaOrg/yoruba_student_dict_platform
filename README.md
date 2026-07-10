# yoruba_student_dict_platform

Hosted, multi-user curation platform for the Yoruba student dictionary -
replaces the local-only tool in
[`yoruba-student-dict`](https://github.com/SpeakNigeriaOrg/yoruba_student_dict)
with an Azure Static Web Apps-hosted app supporting remote login, per-user
review assignment, a volunteer-suggestion review queue, and audio recording.

See `yoruba-student-dict`'s `REMOTE_ACCESS_DISCUSSION.md` for the full design
discussion (requirements, architecture tradeoffs, lessons learned from the
local tool) this repo implements.

## Layout

- `app/` - React (Vite) frontend, deployed to Azure Static Web Apps.
- `api/` - Azure Functions (Node/TS) - the write-side endpoints (save a
  decision, submit/approve a suggestion, upload audio metadata).
- `shared/` - the ported matching/diagnostics engine (TypeScript), a port of
  `yoruba-student-dict/scripts/generate_diagnostics.py` and friends. Runs
  client-side in `app/` for read-only diagnosis/search (no Function call
  needed), and is imported by `api/` for server-side validation of writes.
- `vad-service/` - Python Container App: Silero VAD syllable segmentation,
  ported from `yoruba-student-dict/content/parse_word_syllable_audio.py`
  with its logic unchanged, writing to the database instead of local files.
- `db/` - schema and migrations (Postgres Flexible Server).
- `fixtures/` - golden test fixtures exported from the real Python engine in
  `yoruba-student-dict` (see its `scripts/export_js_port_fixtures.py`),
  used by `shared/`'s test suite to verify the JS port behaves identically
  to the Python original, including the specific bugs found and fixed while
  building it (see `REMOTE_ACCESS_DISCUSSION.md` §4).

## Status

Early scaffold - see the repo's issues/project board (or ask the maintainer)
for current progress against the plan.

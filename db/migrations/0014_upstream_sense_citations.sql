-- 0014_upstream_sense_citations.sql
--
-- Makes a student dictionary entry cite a specific Wiktionary ETYMOLOGY, and
-- makes that citation survive Wiktionary changing underneath it.
--
-- ---------------------------------------------------------------------------
-- Why a spelling is not an identity
-- ---------------------------------------------------------------------------
-- `kọ́` is three different entries in the corpus this database already holds:
-- a negation particle (etymology 3), "to build, construct / to learn, teach"
-- (etymology 2), and "to hang, suspend" (etymology 4). All three carry
-- canonical_value = 'kọ́'.
--
-- So every existing reference to an upstream sense - candidateForm,
-- definitionSourceForm - is ambiguous, and shared/src/diagnoseEntry.ts's
-- findCandidateByForm resolves it by taking the FIRST match. A curator who
-- picks "to hang, suspend" stores only the form, and the next read silently
-- re-resolves to whichever sense the ingest ordered first. Their
-- disambiguation is lost on write.
--
-- This matters most for compounds: golden_record_components references a
-- word_id, so a derived word must point at ONE etymology, not at a spelling
-- that maps to several.
--
-- ---------------------------------------------------------------------------
-- Why entry_id, rather than a key we build ourselves
-- ---------------------------------------------------------------------------
-- kaikki-yoruba already mints one per etymology (e.g. 'en-fa-yo-verb-OFVmd8R8').
-- It reaches ingest/'s DerivedKaikkiSense.entryId and was being discarded.
--
--   Stable:    across build-4 -> build-9, every one of the 6272 entries changed
--              in some field while 100% of ids survived unchanged. The id is
--              not a digest of the whole payload.
--   Necessary: 39 senses collide on (headword, pos, etymology_number), so no
--              locally-reconstructed key can disambiguate them.
--
-- Nullable, not NOT NULL: a corpus ingested before this migration has no ids,
-- and making it NOT NULL here would require truncating the corpus mid-migration
-- and leaving it empty until the next ingest. The next `npm run --workspace=ingest
-- run` populates every row; treat a null as "corpus predates 0014, re-ingest".
alter table kaikki_senses add column entry_id text;
create index idx_kaikki_senses_entry_id on kaikki_senses(entry_id);

comment on column kaikki_senses.entry_id is
  'kaikki-yoruba''s stable per-etymology id. The key for citing a sense - a spelling is not an identity (kọ́ is three etymologies). Null only on a corpus ingested before 0014.';

-- ---------------------------------------------------------------------------
-- The citation, and the copy taken when it was made
-- ---------------------------------------------------------------------------
-- A separate table rather than columns on golden_record: the invariant below is
-- expressible as one constraint here, and golden_record stays about the word
-- rather than about its provenance.
create table upstream_citations (
  word_id        text primary key references golden_record(word_id) on delete cascade,

  -- The cited etymology, or an explicit statement that there isn't one.
  --
  -- The intended rule is that a student entry always cites a Wiktionary
  -- etymology. Real data forces one exception class: 9 of the current 92 words
  -- have no Wiktionary entry at all, systematically rather than accidentally -
  -- loanwords (rédíò, gúáfà, kaṣú, gọ́ọ̀mù, ìnura), traditional calendar names
  -- (Beélú, Ṣẹẹrẹ), and locally-formed compounds (ìfọyín, ẹ jọ̀ọ́).
  --
  -- Enforcing the rule absolutely would either block those words or pressure
  -- someone into citing an unrelated sense to satisfy it, which is worse than
  -- an honest exemption. So the constraint is "cites a sense XOR explains why
  -- it cannot" - which also means a blank can never be mistaken for work
  -- nobody has got round to yet.
  entry_id       text,
  exempt_reason  text,
  constraint upstream_citations_cited_or_exempt check ((entry_id is null) <> (exempt_reason is null)),

  -- The copy taken at validation time: etymologyNumber, pos, canonicalForm,
  -- glosses, etymologyText as they stood when a human made the call.
  --
  -- This is what makes the citation survive upstream edits. An entry renders
  -- and reasons with NO live Kaikki lookup, and reconciliation compares this
  -- pin against a freshly-ingested corpus to classify drift: content edited,
  -- re-identified/renumbered, or disappeared. The pin IS the historical
  -- snapshot, which is why no corpus generations need retaining and why the
  -- ingest can keep truncating.
  --
  -- Generalizes what the schema already does elsewhere: golden_record.definition
  -- is a copy rather than a live lookup, contributions.resolved_value is frozen
  -- at submit (0013), and utterances.recorded_display_text is frozen at
  -- recording (0006). Same principle, applied to the upstream citation.
  pin            jsonb not null,

  -- Which corpus build the pin was taken against, so a citation is
  -- attributable to a version.
  --
  -- Deliberately NOT a foreign key to kaikki_ingestion_runs. 0002 describes
  -- that table as "lightweight observability, not load-bearing for
  -- correctness", and the ingest's own tests truncate it - a hard reference
  -- would make the runs log undeletable and turn a prunable diagnostic into
  -- schema the corpus pipeline has to work around. Recording the uuid gives the
  -- provenance without the coupling; a pruned run simply means "we no longer
  -- know which build", which is exactly as much as an observability record can
  -- promise.
  pinned_run_id  uuid,

  pinned_at      timestamptz not null default now(),
  -- on delete set null: who pinned it is provenance, and it must never be the
  -- reason a user row cannot be removed. The same shape bit assignments.
  -- assigned_by, which has no cascade and wedged test cleanup until it was
  -- handled explicitly.
  pinned_by      uuid references users(user_id) on delete set null
);
create index idx_upstream_citations_entry_id on upstream_citations(entry_id);

comment on table upstream_citations is
  'Which Wiktionary etymology each entry cites, plus the copy of that sense taken at validation. One row per word, or an explicit exempt_reason where no upstream entry exists.';

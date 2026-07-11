-- 0003_kaikki_used_in_candidates.sql
--
-- Reverse of kaikki_component_candidates: kaikki-yoruba computes, for each
-- sense, every OTHER word whose own etymology decomposes to include it
-- (usedInCompounds - see that repo's src/lib/morphemeResolution.mjs).
-- Confirmed real and substantial: mọ̀ ("to know") has 34 real compounds
-- built from it this way. Never ingested before this migration - existed
-- on the canonical artifact's own shape but nothing here read it.
--
-- Same design as kaikki_component_candidates: a candidate SPELLING, not a
-- FK to another kaikki_senses row - resolving it to a real golden_record
-- word_id happens downstream (shared/componentsAxis.ts), the same way the
-- forward table already works.

create table kaikki_used_in_candidates (
  sense_id    uuid not null references kaikki_senses(sense_id) on delete cascade,
  position    int not null,
  form        text not null,
  provenance  text not null check (provenance in ('synthesized_from_etymology')),
  primary key (sense_id, position)
);

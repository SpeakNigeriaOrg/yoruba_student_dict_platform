-- 0031_component_candidate_detail.sql
--
-- What Wiktionary says about each part of an etymology, not just its spelling.
--
-- kaikki_component_candidates held a bare spelling per part, so the etymology screen could say
-- "Wiktionary suggests là" and nothing more - not WHICH là (Wiktionary has five etymologies of it),
-- although the etymology template names the sense it means ({{af|yo|ì-|là|t2=to cut, to divide}}),
-- and kaikki-yoruba has already resolved each part to its candidate entries. Both were dropped at
-- ingest. With them, a reviewer can pick the right Wiktionary etymology for a part straight from the
-- proposal - linking it, or requesting it - instead of retyping its spelling into a search box.
--
-- Bound morphemes (ì-, oní-, -kí-) are now kept as parts too (ingest used to drop them), now that
-- affixes are dictionary entries (0030). Their candidate entries are Wiktionary's own affix entries,
-- matched by spelling at ingest, since kaikki-yoruba never looks bound forms up.
--
-- Both columns are nullable and absent for reciprocal candidates (provenance 'derived_reciprocal'),
-- which come from another entry's derived-terms list and carry no gloss of their own.
alter table kaikki_component_candidates add column gloss text;
alter table kaikki_component_candidates add column candidate_entry_ids text[];

comment on column kaikki_component_candidates.gloss is
  'The gloss the etymology template gives this part (e.g. t2= in {{af}}) - which sense of the spelling the etymology means.';
comment on column kaikki_component_candidates.candidate_entry_ids is
  'Wiktionary entries this part may be, best first (kaikki-yoruba''s resolution; for an affix, its own affix entry). Null when none.';

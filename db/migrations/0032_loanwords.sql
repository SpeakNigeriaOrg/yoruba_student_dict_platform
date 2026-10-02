-- 0032_loanwords.sql
--
-- Whether a word is a loanword, and from what.
--
-- Wiktionary marks a Yoruba loanword in its Etymology section with {{bor|yo|<lang>|<word>}} ("Borrowed
-- from English radio") - 533 of the 6,272 Yoruba entries ingested, mostly from English (346) and
-- Hausa (104). We had nowhere to say it: an exempt word like rédíò, which is exactly the population
-- we would contribute upstream, could not be marked as borrowed at all.
--
-- It is part of the ETYMOLOGY claim - where the word comes from - alongside what it is made of, and
-- is reviewed on that axis. Two columns, not a boolean, because "borrowed" without the source
-- language is not something Wiktionary's markup (or a learner) can use:
--
--   borrowed_from  the source language, as the Wiktionary code {{bor}} takes (shared/src/
--                  loanLanguages.ts); null means not a loanword.
--   borrowed_term  the word it was borrowed as (radio), optional; never without a language.
--
-- kaikki_senses gets the same two, read from each entry's own {{bor}} / {{bor+}} template at ingest,
-- so a reviewer of a cited word starts from what Wiktionary already says rather than re-entering it.
alter table golden_record add column borrowed_from text;
alter table golden_record add column borrowed_term text;
alter table golden_record add constraint golden_record_borrowed_term_needs_language
  check (borrowed_term is null or borrowed_from is not null);

comment on column golden_record.borrowed_from is
  'Loanword source language, as the Wiktionary code {{bor}} takes (en, ha, ar...). Null: not a loanword.';
comment on column golden_record.borrowed_term is
  'The word it was borrowed as (e.g. radio). Optional; requires borrowed_from.';

alter table kaikki_senses add column borrowed_from text;
alter table kaikki_senses add column borrowed_term text;

comment on column kaikki_senses.borrowed_from is
  'From the entry''s own {{bor}}/{{bor+}} etymology template: the source language code. Null when Wiktionary does not mark it borrowed.';

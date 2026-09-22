-- 0029_usage_labels.sql
--
-- Two facts about how a word is USED that the record could not say: that it is
-- obsolete (or archaic, dated...), and that it no longer appears as a separate
-- word at all, surviving only inside other words.
--
-- The case that prompted this is lá "to be big". It is a verb - ńlá is its
-- partial reduplication, the same process that makes títóbi from tóbi, and
-- Wiktionary's own Ayélála etymology treats it as one - but it is not used on
-- its own in modern Yoruba (neither Bowen 1858 nor the CMS dictionary of 1913
-- records it free-standing). With nowhere to say that, it was being filed as a
-- particle, which it is not: Yoruba's particles (kò, ń, bí, ǹjẹ́...) are
-- function words that occur as separate words in every sentence they are in.
-- The same record then went upstream under the wrong heading.
--
-- ---------------------------------------------------------------------------
-- usage_labels: a closed list, because Wiktionary's is
-- ---------------------------------------------------------------------------
-- Each value is a label Module:labels/data defines, written verbatim as the
-- {{lb|yo|...}} argument (shared/src/usageLabels.ts). {{lb}} will display any
-- text at all, which is exactly why a free-text column is wrong here: an
-- undefined label renders, uncategorised, and nothing flags it until a
-- Wiktionary editor does.
--
-- No pin fallback, unlike pos (0018). Upstream's own sense labels arrive in
-- the Kaikki extract as `tags` and are dropped at ingest today, so there is
-- nothing to fall back TO. Carrying them through is a separate change.
--
-- ---------------------------------------------------------------------------
-- only_in_derived_terms: not a label, because no label means it
-- ---------------------------------------------------------------------------
-- There is no defined label for "survives only inside other words", and
-- {{only used in}} - the template that comes closest - asserts the COMPLETE
-- list of words the term occurs in, which no one can know. So this is a flag,
-- written upstream as a usage note that says "such as", and the example words
-- are not stored here: they are the reverse links in golden_record_components
-- (the rows naming this word as a component), which stay right as compounds
-- are added.
--
-- It means "no longer a separate word in sentences", NOT "cannot be said on
-- its own as an utterance" - kò cannot either, and it is a separate word. It
-- does not apply to an affix, which never was a separate word, nor to a
-- character, which is not a word; the check below rules those out for the
-- override column, and the API enforces the same against the resolved pos
-- (override, else pin.pos), which a check constraint cannot see.
alter table golden_record add column usage_labels text[] not null default '{}';
alter table golden_record add column only_in_derived_terms boolean not null default false;

alter table golden_record add constraint golden_record_usage_labels_check
  check (usage_labels <@ array['obsolete', 'archaic', 'dated', 'historical', 'rare']::text[]);
alter table golden_record add constraint golden_record_only_in_derived_terms_check
  check (not (only_in_derived_terms and pos in ('prefix', 'interfix', 'suffix', 'character')));

comment on column golden_record.usage_labels is
  'Wiktionary sense labels ({{lb|yo|...}}) from the closed list in shared/src/usageLabels.ts. No pin fallback: upstream tags are not ingested.';
comment on column golden_record.only_in_derived_terms is
  'The word no longer appears as a separate word, only inside other words (e.g. lá "to be big" in ńlá). Examples come from reverse golden_record_components links. Never true for an affix or a character.';

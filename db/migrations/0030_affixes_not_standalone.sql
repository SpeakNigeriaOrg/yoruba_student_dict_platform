-- 0030_affixes_not_standalone.sql
--
-- golden_record.only_in_derived_terms becomes the ONE answer to "is this a standalone word?".
--
-- 0029 added it for words that stopped being words - lá "to be big", surviving inside ńlá - and
-- made affixes EXEMPT, forcing it off, on the ground that for an affix it only restated the part
-- of speech. That left two ways of saying "not standalone", and any consumer wanting whole words
-- (the game export, first) would have had to know both. An affix is exactly "only ever inside
-- other words", so the flag now says so: always on for prefix / interfix / suffix, still always
-- off for a character (a letter is not a piece of a word), and the reviewer's call otherwise.
-- shared/src/partsOfSpeech.ts holds the rule; the Wiktionary usage note, the one place the
-- restatement would be noise, still skips affixes.
--
-- The check below covers the override column only. An affix whose pos comes from its citation
-- pin is set here from the resolved pos, and kept right by the API afterwards, which resolves pos
-- before writing (entryUsage.ts). Votes and decisions already stored for affix words are repaired
-- by backfillEntryUsageFields, which must run after this migration.

alter table golden_record drop constraint golden_record_only_in_derived_terms_check;

update golden_record g
   set only_in_derived_terms = true
  from golden_record g2
  left join upstream_citations c on c.word_id = g2.word_id
 where g.word_id = g2.word_id
   and not g.only_in_derived_terms
   and coalesce(g2.pos, c.pin ->> 'pos') in ('prefix', 'interfix', 'suffix');

alter table golden_record add constraint golden_record_only_in_derived_terms_check
  check (
    not (pos in ('prefix', 'interfix', 'suffix') and not only_in_derived_terms)
    and not (pos = 'character' and only_in_derived_terms)
  );

comment on column golden_record.only_in_derived_terms is
  'Not a standalone word: always true for an affix, always false for a character, otherwise the reviewer''s call (e.g. lá "to be big", surviving only inside ńlá). The game export leaves these out. Examples come from reverse golden_record_components links.';

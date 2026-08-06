-- 0016_kaikki_ipa.sql
--
-- Keep the IPA Wiktionary already gives us, as a CHECK on our syllable splitting.
--
-- ---------------------------------------------------------------------------
-- Why this is worth a column
-- ---------------------------------------------------------------------------
-- A nasal after a vowel is either a coda nasalising that vowel or a syllable of its own, and bare
-- spelling does not always say which. We settle what the letters settle and default the rest, and
-- until now there was nothing at all to check that default against.
--
-- Wiktionary's IPA answers it directly, with explicit syllable boundaries, for 5,040 of 6,272
-- entries:
--
--     ẹṣin       /ɛ̄.ʃĩ̄/           2 syllables, tilde on the vowel  -> CODA
--     irin       /ī.ɾĩ̄/            2                                -> coda
--     olóńgbò    /ō.ló.ŋ́.ɡ͡bò/      4, ŋ́ standing alone              -> SYLLABIC
--     Abím̄bọ́lá  /ā.bí.ŋ̄.bɔ́.lá/    5                                -> syllabic
--
-- Measured on that evidence, our splitter agrees on the nasal decision for 3,993 of 3,996
-- single-word forms with usable IPA. That number is the reason the coda default was kept rather
-- than replaced - and it could not be computed at all before, because ingest parsed this field
-- (ingest/src/types.ts's `ipa`) and threw it away.
--
-- ---------------------------------------------------------------------------
-- A check, deliberately NOT a source of truth
-- ---------------------------------------------------------------------------
-- IPA's unit is the phonetic syllable; ours is the tone-bearing unit. They disagree on 332 forms
-- where OURS is the one we want: `àámú` is /àá.mṹ/ to Wiktionary (2) and ['à','á','mú'] to us (3),
-- because `à` and `á` carry different tones and the game plays one clip and asks one tone per unit.
-- So nothing derives a split from this column. It exists so a script can flag the one class IPA is
-- authoritative about: a standalone nasal syllable in the IPA where our split has a coda. That is
-- 1 form today - `Ṣóyínká`, /ʃó.jí.ŋ̄.ká/, where Wiktionary's own spelling and its own IPA
-- disagree with each other.
--
-- Nullable, because 374 entries have no IPA and 858 more have it without syllable boundaries. A
-- missing transcription is "nothing to check against", never a problem with the word.
--
-- Only the FIRST transcription is kept. Entries with several are dialect variants, and a
-- disagreement between them is a fact about Yoruba rather than about our splitting - picking one
-- keeps this a check on us instead of turning it into a second lexicon to reconcile.

alter table kaikki_senses add column ipa text;

comment on column kaikki_senses.ipa is
  'Wiktionary IPA for this etymology, first transcription only, verbatim including its syllable dots. A CHECK on our syllable splitting, never a source for it - see 0016.';

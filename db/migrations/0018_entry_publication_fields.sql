-- 0018_entry_publication_fields.sql
--
-- The three things an entry needs to be emitted as a Wiktionary entry, and
-- cannot say today.
--
-- ---------------------------------------------------------------------------
-- Overrides, not copies
-- ---------------------------------------------------------------------------
-- 0014's pin already holds pos, etymologyNumber, canonicalForm, glosses and
-- etymologyText as upstream stated them when a human validated the citation. So
-- for a CITED entry, two of the three columns below are already answered, and
-- copying them here would create the second home for one fact that this schema
-- avoids everywhere else (0001's note on syllable_observations; 0011's note on
-- definitionStatus drifting from its override).
--
-- These columns are therefore OVERRIDES, read only when set:
--
--     pos            <- pin.pos            when null
--     english_gloss  <- pin.glosses        when null
--     etymid_label   <- derived from word_id when null (see below)
--
-- which means no backfill, and a null is never a gap for the ~80 cited words.
-- It is a gap for exactly the population that needs one: the entries with an
-- exempt citation - a real word with no Wiktionary entry - which are also the
-- only entries we would ever actually contribute upstream. Those have an empty
-- pin ({}, written by upstreamCitations.ts) and so have no pos and no gloss
-- anywhere in the database at all.
--
-- ---------------------------------------------------------------------------
-- Why a gloss is not the definition we already have
-- ---------------------------------------------------------------------------
-- golden_record.definition is deliberately a SIMPLIFICATION for students - the
-- Add Word screen says so on the field itself ("Simplifying Wiktionary's wording
-- is expected - it is a simplification, not a correction"). That is the right
-- text for a learner and the wrong text for a Wiktionary sense line, which wants
-- the ordinary lexicographic wording. One column cannot be both without the
-- generator either publishing simplified prose upstream or showing upstream's
-- prose to a student. Two fields, two audiences.
alter table golden_record add column pos text;
alter table golden_record add column english_gloss text;
alter table golden_record add column etymid_label text;

comment on column golden_record.pos is
  'Part of speech for output, when the citation pin does not supply it (an exempt entry has an empty pin) or contradicts it. Null means "use pin.pos".';
comment on column golden_record.english_gloss is
  'The sense line as it would be published upstream - ordinary lexicographic wording, NOT golden_record.definition, which is deliberately simplified for students. Null means "use pin.glosses".';

-- ---------------------------------------------------------------------------
-- etymid, and why we already have one for every entry
-- ---------------------------------------------------------------------------
-- {{etymid|yo|<label>}} gives an etymology a stable, editor-authored anchor, and
-- it is the fix reconcileUpstream.ts's own header names for the re-identification
-- churn it exists to absorb: a content-derived id moves whenever prose is
-- polished, a label does not. Upstream barely uses it - 72 occurrences across the
-- whole 6,272-entry corpus - and the label is always a short English
-- disambiguator: {{etymid|yo|tie down}}, {{etymid|yo|plantain}},
-- {{etymid|yo|to roast, burn}}.
--
-- That is exactly what a word_id hint is. `owo_hand` and `jeun_eat` were minted by
-- a curator at the moment they picked the etymology, from that etymology's own
-- primary gloss (AddWord.tsx's hintFromGloss), for the same purpose: telling apart
-- the several etymologies that share one spelling. So the label is already
-- authored for every entry we hold; it is just spelled with underscores and
-- carried in a primary key.
--
-- Deliberately NOT backfilled in SQL. Recovering the hint means stripping
-- orthographyInsensitiveForm(display_text) from the front of word_id, and that
-- function lives in shared/ - reimplementing it here would be the third
-- independent copy of orthography logic this schema explicitly refuses to grow
-- (0001's syllable_observations note). The generator derives it with the real
-- function and falls back to this column only when the derivation is wrong,
-- which is the only case where a human needs to say anything.
comment on column golden_record.etymid_label is
  'Override for the {{etymid|yo|...}} label. Null means "derive it from the word_id hint", which is what a hint already is - a short English disambiguator chosen when the etymology was picked.';

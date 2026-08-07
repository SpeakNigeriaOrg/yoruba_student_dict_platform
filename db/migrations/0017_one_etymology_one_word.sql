-- 0017_one_etymology_one_word.sql
--
-- Make "an entry IS a Wiktionary etymology" a constraint instead of a convention.
--
-- ---------------------------------------------------------------------------
-- The invariant, and why it was only ever assumed
-- ---------------------------------------------------------------------------
-- 0014 established that a dictionary entry IS one Wiktionary etymology, cited at creation. Two words
-- citing one etymology is therefore two words claiming one identity - not a duplicate spelling, an
-- actual contradiction.
--
-- Code already relied on this being true. resolveOrRequestComponent asks `where c.entry_id = $1` and
-- takes the first row, which is only correct if there can be at most one. But the primary key here is
-- word_id, so nothing prevented a second: the invariant was unprecedented rather than enforced.
--
-- The gap was reachable. The curator Add Word flow never asked whether the etymology it was offering
-- was already held - it compared SPELLINGS after the fact - so `jẹun` could be added a second time
-- while `jeun_eat` already cited the very etymology on offer.
--
-- ---------------------------------------------------------------------------
-- Safe on today's data, measured rather than hoped
-- ---------------------------------------------------------------------------
-- Production at the time of writing: 87 citation rows = 80 cited to an entry_id + 7 exempt. Among the
-- 80, there are 80 DISTINCT entry_ids - zero collisions, and zero cited ids missing from the corpus.
-- So this index needs no data repair and no backfill; it records a property the data already has.
--
-- The 7 exempt rows carry entry_id NULL (the 0014 CHECK makes entry_id and exempt_reason mutually
-- exclusive), and any number of them must coexist. Two things make that safe: the partial predicate
-- excludes them outright, and Postgres treats NULLs as distinct in a unique index anyway. Verified
-- empirically before writing this, not reasoned about - two NULL rows insert fine, a duplicate
-- entry_id is rejected.
--
-- Not CONCURRENTLY: 87 rows takes milliseconds, and the migration runner wraps each file in a
-- transaction, where CREATE INDEX CONCURRENTLY is not allowed.
--
-- 0014's idx_upstream_citations_entry_id is deliberately LEFT IN PLACE. Dropping it would be a
-- defensible write-cost cleanup, and bundling it here would make this migration about two things.

create unique index upstream_citations_entry_id_unique
  on upstream_citations (entry_id)
  where entry_id is not null;

comment on index upstream_citations_entry_id_unique is
  'One etymology, one word. An entry IS a Wiktionary etymology (0014), so a second word citing the same entry_id is two words claiming one identity. Exempt rows (entry_id null) are excluded and may be many.';

-- ---------------------------------------------------------------------------
-- The same invariant, one step earlier: at most one open REQUEST per etymology
-- ---------------------------------------------------------------------------
-- A volunteer who hits a missing component can request it, and resolveOrRequestComponent deliberately
-- returns the EXISTING request rather than creating a second, so two volunteers naming the same
-- missing part agree on the planned word_id. `new_entry` sits outside consensus entirely (no
-- fingerprint - the proposal IS the content), so that deduplication is not an optimisation, it is the
-- whole mechanism.
--
-- And it was advisory. The check is a read-then-write with no constraint behind it, and pickFreeWordId
-- is also a pure read, so two concurrent requests for one etymology both insert AND derive the SAME
-- planned word_id. Whichever is approved second then dies on WordIdAlreadyExistsError and becomes a
-- permanently unapprovable row in the queue. Not yet observed in production - 1 active request, 0
-- duplicates on either key - which is why this is prevention and needs no cleanup.
--
-- Two keys, because a request has two ways of being the same request:
--   entryId       - the etymology, the real identity. NULL for an exempt request.
--   proposedWordId- always present, and the key an exempt request must be deduplicated on. Also
--                   exactly the collision that produces the unapprovable row above.
--
-- Both are partial to active new_entry rows: a superseded or applied request is history and must not
-- block a later one, and 0013's contributions_one_active_vote_per_user cannot cover new_entry at all
-- because its word_id is null there.

create unique index contributions_one_active_request_per_etymology
  on contributions ((proposed_value -> 'citation' ->> 'entryId'))
  where axis = 'new_entry' and status = 'active';

create unique index contributions_one_active_request_per_word_id
  on contributions ((proposed_value ->> 'proposedWordId'))
  where axis = 'new_entry' and status = 'active';

comment on index contributions_one_active_request_per_etymology is
  'At most one OPEN request per etymology. Deduplication is the entire mechanism for new_entry (it has no fingerprint and takes no part in consensus), so it cannot be left to a read-then-write.';

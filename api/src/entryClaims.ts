// entryClaims.ts
//
// "Is this Wiktionary etymology already someone's identity?" - asked once, in one place.
//
// ---------------------------------------------------------------------------
// Why this is a module and not two ad-hoc queries
// ---------------------------------------------------------------------------
// Since 0014 an entry IS a Wiktionary etymology, so `entry_id` answers that question EXACTLY: the
// corpus carries one entry_id per etymology (6,272 senses, 6,272 distinct ids), which makes equality
// identity rather than resemblance.
//
// The volunteer path had known this since Phase H - resolveOrRequestComponent asked it before
// creating a component. The CURATOR path never did, and instead fell back to comparing spellings.
// That is what let `jẹun` be offered as a new word when `jeun_eat` already cited the very etymology
// on offer: the authoritative answer was one query away and nobody ran it. The two paths asking the
// same question through the same code is the point of this file - a second copy is how they drifted
// in the first place.
//
// ---------------------------------------------------------------------------
// Batched, because the caller has a result SET
// ---------------------------------------------------------------------------
// Kaikki search returns up to 15 results and must label every one, so the lookups take an array and
// return a Map. Fifteen round trips to answer one question per row would be the obvious way and the
// wrong one, particularly on a handler that already loads the whole 6,272-sense corpus per request.

import type { EntryClaim } from '@yoruba-student-dict-platform/shared';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from './db.js';

/** A dictionary word whose identity `entry_id` cannot speak for.
 *
 * Two populations, one consequence: words with no citation row at all (pre-0014 legacy) and exempt
 * words (`entry_id` null - a real word with no Wiktionary entry). For these, and ONLY these, a
 * shared spelling is the best signal available. `base` is precomputed because the caller compares it
 * against every standardForm of every result. */
export interface IdentityUncomparableWord {
  wordId: string;
  displayText: string;
  base: string;
}

/** Which of these etymologies are already taken, and by what.
 *
 * A word in the dictionary BEATS a pending request for the same etymology - the same precedence
 * resolveOrRequestComponent applies by asking in that order. If a word exists, the request is
 * already satisfied whether or not anyone has closed it. */
export async function loadEntryClaims(client: Queryable, entryIds: readonly string[]): Promise<Map<string, EntryClaim>> {
  const claims = new Map<string, EntryClaim>();
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return claims;

  // Pending first, so the dictionary pass below can overwrite it rather than needing a guard.
  const pending = await client.query<{ entry_id: string; word_id: string; display_text: string; contribution_id: string }>(
    `select proposed_value -> 'citation' ->> 'entryId' as entry_id,
            proposed_value ->> 'proposedWordId'        as word_id,
            proposed_value ->> 'displayText'           as display_text,
            contribution_id
       from contributions
      where axis = 'new_entry' and status = 'active'
        and proposed_value -> 'citation' ->> 'entryId' = any($1::text[])`,
    [ids],
  );
  for (const row of pending.rows) {
    claims.set(row.entry_id, {
      status: 'requested',
      wordId: row.word_id,
      displayText: row.display_text,
      contributionId: row.contribution_id,
    });
  }

  const held = await client.query<{ entry_id: string; word_id: string; display_text: string }>(
    `select c.entry_id, g.word_id, g.display_text
       from upstream_citations c join golden_record g on g.word_id = c.word_id
      where c.entry_id = any($1::text[])`,
    [ids],
  );
  for (const row of held.rows) {
    claims.set(row.entry_id, { status: 'in_dictionary', wordId: row.word_id, displayText: row.display_text });
  }

  return claims;
}

/** The single-etymology case, over the batch so there is one query shape to maintain. */
export async function loadEntryClaim(client: Queryable, entryId: string): Promise<EntryClaim | null> {
  return (await loadEntryClaims(client, [entryId])).get(entryId) ?? null;
}

/** The word citing this etymology, if any - the enforcement question, which wants only an id.
 *
 * Separate from loadEntryClaim because a PENDING request must not block a write: a request is a plan,
 * and the whole point of approving one is to turn it into the word. */
export async function findWordCiting(client: Queryable, entryId: string): Promise<string | null> {
  const { rows } = await client.query<{ word_id: string }>(
    'select word_id from upstream_citations where entry_id = $1 limit 1',
    [entryId],
  );
  return rows.length > 0 ? rows[0].word_id : null;
}

/** Every word for which entry-id identity is structurally silent. ~12 rows, so no filtering by query. */
export async function loadIdentityUncomparableWords(client: Queryable): Promise<IdentityUncomparableWord[]> {
  const { rows } = await client.query<{ word_id: string; display_text: string }>(
    `select g.word_id, g.display_text
       from golden_record g left join upstream_citations c on c.word_id = g.word_id
      where c.word_id is null or c.entry_id is null`,
  );
  return rows.map((row) => ({
    wordId: row.word_id,
    displayText: row.display_text,
    base: orthographyInsensitiveForm(row.display_text),
  }));
}

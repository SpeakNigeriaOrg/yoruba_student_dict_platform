// handlers/components.ts
//
// The one place a golden_record_components list is validated and written.
//
// Three handlers write this table - createPhrase (a phrase IS its components),
// createWord (an optional decomposition, recorded at creation), and
// applyEtymologyDecision (a curator's review of one) - and all three share the
// existence CHECK below, which had been living here in three copies of the same
// six lines.
//
// Only the first two share the write. applyEtymologyDecision deletes before
// inserting and stamps updated_by, which is a REPLACEMENT of an existing list
// rather than the first write of one; folding both shapes into one helper would
// mean a flag that changes what the function does.
//
// ComponentsNotFoundError lives here for the same reason, and it is the reason
// worth stating: it used to be declared TWICE, identically, in createPhrase and
// applyEtymologyDecision. Two classes of one name are two different answers to
// `instanceof`, and functions/approveContribution.ts had imported the name from
// the file that could not raise it on the path it was guarding - a check that
// never matched, hidden by an `err instanceof Error` fallback returning the same
// 400. One class, one answer.
//
// The foreign key on component_word_id is the real enforcement that every
// component names a real word. The existence pre-check here exists only so a
// curator meets a specific list of missing ids instead of a raw FK violation -
// same rationale the Python tool's resolve_server.py:249-260 gave.

import type { Queryable } from '../db.js';

export class ComponentsNotFoundError extends Error {
  constructor(public readonly missingWordIds: string[]) {
    super(`component word_id(s) not found in golden_record: ${missingWordIds.join(', ')}`);
    this.name = 'ComponentsNotFoundError';
  }
}

/** Throws unless every id names a row already in golden_record.
 *
 * Components may only reference COMMITTED words, never another still-pending draft - the pickers
 * that feed this search the dictionary, so they cannot offer one, and the FK would refuse it. */
export async function assertComponentsExist(client: Queryable, components: string[]): Promise<void> {
  if (components.length === 0) return;
  const found = await client.query<{ word_id: string }>(
    'select word_id from golden_record where word_id = any($1)',
    [components],
  );
  const foundIds = new Set(found.rows.map((r) => r.word_id));
  const missing = components.filter((c) => !foundIds.has(c));
  if (missing.length > 0) {
    throw new ComponentsNotFoundError(missing);
  }
}

/** Writes the list in order, position by position.
 *
 * A word_id may REPEAT: a reduplication like `méjì méjì` is two positions holding one word, and
 * (word_id, component_position) is the primary key - so the repeat is representable and the list is
 * deliberately not de-duplicated on the way in. */
export async function writeComponents(client: Queryable, wordId: string, components: string[]): Promise<void> {
  for (const [position, componentWordId] of components.entries()) {
    await client.query(
      `insert into golden_record_components (word_id, component_position, component_word_id)
       values ($1, $2, $3)`,
      [wordId, position, componentWordId],
    );
  }
}

// handlers/createWord.ts
//
// Backs the Add Word screen's direct-insert path (curator-gated - see the
// approved plan's "curator-gated authoring" decision; a volunteer instead
// submits a 'new_entry' contribution, see handlers/submitContribution.ts).
// A plain word gets zero golden_record_components rows - an atomic word
// has no real decomposition, not a self-referencing placeholder (see
// db/migrations/0001_initial_schema.sql).
//
// This is where a word acquires its identity, and identity means the Wiktionary
// etymology it cites - not its spelling. Adding a word IS choosing an etymology
// (the Add Word screen searches Kaikki and the human picks one), so the citation
// is captured at the one moment it is unambiguous and free. Every path that
// creates a word goes through here or createPhrase.ts, which is what keeps
// "every entry cites an etymology, or says why it cannot" true by construction
// rather than by backfill.

import type pg from 'pg';
import { isUniqueViolation, withTransaction, type Queryable } from '../db.js';
import { WordIdAlreadyExistsError } from './errors.js';
import { writeCitationInTransaction, type UpstreamCitationInput } from './upstreamCitations.js';

export interface CreateWordInput {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition?: string | null;
  /** Required, not optional. A student dictionary entry IS a Wiktionary
   * etymology, so a word cannot come into existence without saying which one -
   * or, for the off-path cases that genuinely have no upstream entry, without
   * saying why there is none.
   *
   * Required at the TYPE level and not just by the 0014 constraint because the
   * whole point is that this is knowable at creation: whoever adds a word picked
   * an etymology to add. Deriving it later from the spelling is impossible - one
   * spelling maps to several etymologies (`kọ́` is three). */
  citation: UpstreamCitationInput;
}

export { WordIdAlreadyExistsError };

/** Accepts a pg.Pool specifically (not just Queryable) since the word and its
 * citation must be written in ONE transaction - a word that exists with no
 * citation is the state 0014 exists to make unrepresentable, and two inserts on
 * a Pool would run on two different connections. Mirrors createPhrase.ts. */
export async function createWord(pool: pg.Pool, input: CreateWordInput, createdBy: string): Promise<void> {
  await withTransaction(pool, (client) => createWordInTransaction(client, input, createdBy));
}

/** Exported so approveContribution.ts's 'new_entry' path can compose this into
 * its own single transaction, rather than opening a second one. */
export async function createWordInTransaction(client: Queryable, input: CreateWordInput, createdBy: string): Promise<void> {
  const existing = await client.query('select 1 from golden_record where word_id = $1', [input.wordId]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new WordIdAlreadyExistsError(input.wordId);
  }

  try {
    await client.query(
      `insert into golden_record (word_id, display_text, syllables, definition, updated_by)
       values ($1, $2, $3, $4, $5)`,
      [input.wordId, input.displayText, input.syllables, input.definition ?? null, createdBy],
    );
  } catch (err) {
    // The pre-check above closes the common case with a clean error, but
    // can't close a race between two concurrent creates of the same
    // word_id - the primary key is the real enforcement; this just gives
    // that race the same clean error instead of a raw constraint-violation.
    if (isUniqueViolation(err)) {
      throw new WordIdAlreadyExistsError(input.wordId);
    }
    throw err;
  }

  await writeCitationInTransaction(client, input.wordId, input.citation, createdBy);
}


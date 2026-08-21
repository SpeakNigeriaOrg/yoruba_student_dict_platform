// handlers/createWord.ts
//
// Backs the Add Word screen's direct-insert path (curator-gated - see the
// approved plan's "curator-gated authoring" decision; a volunteer instead
// submits a 'new_entry' contribution, see handlers/submitContribution.ts).
// A plain word gets zero golden_record_components rows - an atomic word
// has no real decomposition, not a self-referencing placeholder (see
// db/migrations/0001_initial_schema.sql). Most words are that word, which is
// why `components` below is optional and normally absent; a word that IS built
// from words we already hold can now say so here instead of being created
// atomic and corrected afterwards on its etymology axis.
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
import { assertWordIdShape } from './wordIdShape.js';
import { writeCitationInTransaction, type UpstreamCitationInput } from './upstreamCitations.js';
import { assertComponentsExist, ComponentsNotFoundError, writeComponents } from './components.js';
import { recordAuthoringVote } from './authoringVote.js';

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
  /** word_ids this word is built from, in order - optional, and for most words correctly absent.
   *
   * Unlike a phrase's, this list is not the word's identity: a word IS the etymology it cites (0017),
   * and its decomposition is a separate claim ABOUT it. So zero components is a perfectly good answer
   * and the ordinary one - `ilé` is not made of anything - which is why this is optional here and
   * required in createPhrase.
   *
   * Writing it does NOT decide the etymology axis. No word_decisions row is written, so the word still
   * reaches review with its decomposition as a proposal a curator confirms - exactly the state
   * createPhrase leaves a phrase in. A claim made while adding a word is a good starting point and not
   * a substitute for the review that checks it. */
  components?: string[];
  /** 0018's publication overrides - all optional, and normally all absent.
   *
   * A cited word needs none of them: the pin already holds pos and glosses as upstream stated
   * them when a human validated the citation, and the etymid label is what the word_id hint
   * already is. They exist for the population with no pin to read - a word carrying an exempt
   * citation, which is also the only kind of word we would ever actually contribute upstream.
   * See 0018 for why these are overrides rather than copies. */
  pos?: string | null;
  englishGloss?: string | null;
  etymidLabel?: string | null;
}

export { WordIdAlreadyExistsError, ComponentsNotFoundError };

/** Accepts a pg.Pool specifically (not just Queryable) since the word and its
 * citation must be written in ONE transaction - a word that exists with no
 * citation is the state 0014 exists to make unrepresentable, and two inserts on
 * a Pool would run on two different connections. Mirrors createPhrase.ts. */
export async function createWord(pool: pg.Pool, input: CreateWordInput, createdBy: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await createWordInTransaction(client, input, createdBy);
    // The author's own vote for what they just wrote - see authoringVote.ts. Here rather than
    // inside createWordInTransaction because approveContribution composes that one to apply a
    // VOLUNTEER's proposal, where the approving curator is not the author.
    await recordAuthoringVote(client, input.wordId, createdBy, {
      hasComponents: (input.components?.length ?? 0) > 0,
    });
  });
}

/** Exported so approveContribution.ts's 'new_entry' path can compose this into
 * its own single transaction, rather than opening a second one. */
export async function createWordInTransaction(client: Queryable, input: CreateWordInput, createdBy: string): Promise<void> {
  // Before the existence check, so a badly shaped id is named as such rather than reported as
  // available. See wordIdShape.ts: this id becomes a filename and a storage key.
  assertWordIdShape(input.wordId);

  const existing = await client.query('select 1 from golden_record where word_id = $1', [input.wordId]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new WordIdAlreadyExistsError(input.wordId);
  }

  try {
    await client.query(
      `insert into golden_record (word_id, display_text, syllables, definition, pos, english_gloss, etymid_label, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.wordId,
        input.displayText,
        input.syllables,
        input.definition ?? null,
        input.pos ?? null,
        input.englishGloss ?? null,
        input.etymidLabel ?? null,
        createdBy,
      ],
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

  // Before the citation only because both are inside the one transaction and neither can outlive a
  // failure of the other - a word with components but no citation is the state 0014 forbids just as
  // much as a word with neither.
  await assertComponentsExist(client, input.components ?? []);
  await writeComponents(client, input.wordId, input.components ?? []);

  await writeCitationInTransaction(client, input.wordId, input.citation, createdBy);
}


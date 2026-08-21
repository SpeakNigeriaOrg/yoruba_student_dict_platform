// handlers/createPhrase.ts
//
// Backs the Add Phrase screen's direct-insert path (curator-gated, same as
// createWord.ts). Components must reference already-existing golden_record
// word_ids only, never another still-pending draft - matching today's
// tool exactly (its vocab-search component picker can only see words
// already committed). The golden_record_components foreign key is the
// real enforcement of that; the existence pre-check here exists only to
// give a clean, specific error instead of a raw FK-violation (mirrors
// resolve_server.py:249-260's identical rationale).
//
// definition is the student-facing meaning and was missing entirely: this insert did not name the
// column, so a phrase created here was a dictionary entry with no meaning attached. See the field's
// own note below for why it is not the same value as english_gloss, even when it starts as a copy.
//
// displayText and syllables are AUTHORED, not derived from the components. They arrive from the
// phrase tab's tone grid, and this handler stores what it is given. The Add Phrase screen used to
// compute both by joining the parts, which made a phrase whose surface form differs from its parts -
// `o ṣé` for `o` + `ṣe`, `muti` for {{contraction|yo|mu|ọtí}} - unstorable. The components remain a
// claim about which words the phrase is built from, which is a different claim from how it is spelled;
// shared/src/phraseSpelling.ts reports where the two diverge.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { WordIdAlreadyExistsError } from './errors.js';
import { assertWordIdShape } from './wordIdShape.js';
import { writeCitationInTransaction } from './upstreamCitations.js';

export interface CreatePhraseInput {
  wordId: string;
  displayText: string;
  syllables: string[];
  /** word_ids, in order - component_position is each entry's array index. A word_id may REPEAT: a
   * reduplication like `méjì méjì` is two positions holding one word, and the position is the key. */
  components: string[];
  /** The student-facing meaning, in the plain wording a learner reads.
   *
   * This handler had no such parameter, so every phrase ever created here landed with definition
   * null - a phrase in the dictionary that says nothing about what it means, which is the one thing
   * a student needs from it. Nothing filled it in afterwards either: the Add Phrase screen had no
   * field for it, and the only route to one was opening the finished entry and using the entry
   * axis's `definitionAction: 'custom'`, i.e. a second pass over work that was just done.
   *
   * Distinct from englishGloss below, which is 0018's publication field - the ordinary lexicographic
   * wording we would send upstream. Two audiences, two columns (see 0018 on why one column cannot be
   * both). The screen seeds this one FROM that one, which is a default a human can edit, not a
   * derivation. */
  definition?: string | null;
  /** The phrase's OWN Wiktionary etymology, when upstream has one for the whole phrase.
   *
   * Optional, and absence still means the by-nature exemption below. Wiktionary has multi-word entries
   * - 480 of our 6272 - so a phrase frequently DOES have an etymology of its own, distinct from its
   * parts' ("hail the king" is not the sum of its words). Refusing to record it, as this used to,
   * threw away the one thing 0017 made the identity, and left drift detection with nothing to check. */
  citation?: { entryId: string };
  /** 0018's publication overrides. Same rule as createWord's, and MORE often needed here: a
   * locally composed phrase takes the by-nature exemption below, so its pin is empty and
   * nothing else in the database knows its part of speech or how to gloss it in English. */
  pos?: string | null;
  englishGloss?: string | null;
  etymidLabel?: string | null;
}

export { WordIdAlreadyExistsError };

export class NoComponentsError extends Error {
  constructor() {
    super('a phrase needs at least one component');
    this.name = 'NoComponentsError';
  }
}

export class ComponentsNotFoundError extends Error {
  constructor(public readonly missingWordIds: string[]) {
    super(`component word_id(s) not found in golden_record: ${missingWordIds.join(', ')}`);
    this.name = 'ComponentsNotFoundError';
  }
}

/** Accepts a pg.Pool specifically (not just Queryable) since this handler
 * needs a real transaction across its multiple inserts - createWord.ts's
 * single insert doesn't. */
export async function createPhrase(pool: pg.Pool, input: CreatePhraseInput, createdBy: string): Promise<void> {
  if (input.components.length === 0) {
    throw new NoComponentsError();
  }

  await withTransaction(pool, (client) => createPhraseInTransaction(client, input, createdBy));
}

/** Exported so approveContribution.ts's 'new_entry' (phrase) path can
 * compose this into its own single transaction, rather than calling
 * createPhrase (which would open a second, separate transaction). */
export async function createPhraseInTransaction(client: Queryable, input: CreatePhraseInput, createdBy: string): Promise<void> {
  assertWordIdShape(input.wordId);

  const existingWord = await client.query('select 1 from golden_record where word_id = $1', [input.wordId]);
  if ((existingWord.rowCount ?? 0) > 0) {
    throw new WordIdAlreadyExistsError(input.wordId);
  }

  const existingComponents = await client.query<{ word_id: string }>(
    'select word_id from golden_record where word_id = any($1)',
    [input.components],
  );
  const foundIds = new Set(existingComponents.rows.map((r) => r.word_id));
  const missing = input.components.filter((c) => !foundIds.has(c));
  if (missing.length > 0) {
    throw new ComponentsNotFoundError(missing);
  }

  await client.query(
    `insert into golden_record (word_id, display_text, syllables, entry_type, definition, pos, english_gloss, etymid_label, updated_by)
     values ($1, $2, $3, 'phrase', $4, $5, $6, $7, $8)`,
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

  for (const [position, componentWordId] of input.components.entries()) {
    await client.query(
      `insert into golden_record_components (word_id, component_position, component_word_id)
       values ($1, $2, $3)`,
      [input.wordId, position, componentWordId],
    );
  }

  // Exactly one citation row either way, because the alternative is three states - cited, explicitly
  // exempt, and simply absent - where "absent" would mean both "a phrase, correctly" and "a word nobody
  // has got round to". The publish gate and the reconciliation queue both need "no row" to mean one
  // thing.
  //
  // WHICH row depends on whether upstream has an entry for the whole phrase:
  //
  //   cited  - it does, so record it. A phrase's composition and its own etymology are different facts
  //            and recording one never precluded the other; the code simply never offered the choice.
  //            0014's constraint is entryId XOR exempt_reason per row, so this needs no migration, and
  //            0017's unique index then covers phrases too - correctly, since one etymology is one
  //            entry whatever its shape.
  //   exempt - it does not (a locally composed phrase). Its identity is not missing but derived: a
  //            composition of golden_record words, each citing its own etymology.
  await writeCitationInTransaction(
    client,
    input.wordId,
    input.citation ?? {
      exemptReason: 'composed phrase - its identity comes from its components, each of which cites its own etymology',
    },
    createdBy,
  );
}

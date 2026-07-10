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

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';

export interface CreatePhraseInput {
  wordId: string;
  displayText: string;
  syllables: string[];
  /** word_ids, in order - component_position is each entry's array index. */
  components: string[];
}

export class WordIdAlreadyExistsError extends Error {
  constructor(public readonly wordId: string) {
    super(`word_id '${wordId}' already exists in golden_record`);
    this.name = 'WordIdAlreadyExistsError';
  }
}

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

async function createPhraseInTransaction(client: Queryable, input: CreatePhraseInput, createdBy: string): Promise<void> {
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
    `insert into golden_record (word_id, display_text, syllables, entry_type, updated_by)
     values ($1, $2, $3, 'phrase', $4)`,
    [input.wordId, input.displayText, input.syllables, createdBy],
  );

  for (const [position, componentWordId] of input.components.entries()) {
    await client.query(
      `insert into golden_record_components (word_id, component_position, component_word_id)
       values ($1, $2, $3)`,
      [input.wordId, position, componentWordId],
    );
  }
}

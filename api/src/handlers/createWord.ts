// handlers/createWord.ts
//
// Backs the Add Word screen's direct-insert path (curator-gated - see the
// approved plan's "curator-gated authoring" decision; a volunteer instead
// submits a 'new_entry' contribution, see handlers/submitContribution.ts).
// A plain word gets zero golden_record_components rows - an atomic word
// has no real decomposition, not a self-referencing placeholder (see
// db/migrations/0001_initial_schema.sql).

import type { Queryable } from '../db.js';

export interface CreateWordInput {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition?: string | null;
}

export class WordIdAlreadyExistsError extends Error {
  constructor(public readonly wordId: string) {
    super(`word_id '${wordId}' already exists in golden_record`);
    this.name = 'WordIdAlreadyExistsError';
  }
}

export async function createWord(db: Queryable, input: CreateWordInput, createdBy: string): Promise<void> {
  const existing = await db.query('select 1 from golden_record where word_id = $1', [input.wordId]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new WordIdAlreadyExistsError(input.wordId);
  }

  try {
    await db.query(
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
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === '23505');
}

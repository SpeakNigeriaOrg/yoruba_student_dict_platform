// handlers/excludeExample.ts
//
// Removes an example from the collection without destroying it.
//
// 0015 gave word_examples excluded_by/excluded_at/excluded_reason and said what they were
// for - "a curator can remove something abusive or off-topic" - and then no endpoint was
// ever written, so the columns could only ever be cleared, never set. A moderation control
// that exists in the schema and nowhere else is not a moderation control.
//
// Exclusion, not deletion, for the same reason 0013 gives for contributions: the row is
// what happened. It stops counting - listExamples filters excluded_at, the example axis
// stops reading as done for its author, and exportWiktionaryDrafts stops publishing it -
// while remaining readable on the word's dossier with the reason attached.

import type { Queryable } from '../db.js';

export class ExampleNotFoundError extends Error {
  constructor(public readonly exampleId: string) {
    super(`no example with id '${exampleId}'`);
    this.name = 'ExampleNotFoundError';
  }
}

export class ExampleAlreadyExcludedError extends Error {
  constructor(public readonly exampleId: string) {
    super(`example '${exampleId}' is already excluded`);
    this.name = 'ExampleAlreadyExcludedError';
  }
}

export async function excludeExample(
  db: Queryable,
  exampleId: string,
  reason: string,
  excludedBy: string,
): Promise<void> {
  if (!reason.trim()) throw new Error('a reason is required - an exclusion nobody can explain is not reviewable');

  const existing = await db.query<{ excluded_at: string | null }>(
    'select excluded_at from word_examples where example_id = $1',
    [exampleId],
  );
  if ((existing.rowCount ?? 0) === 0) throw new ExampleNotFoundError(exampleId);
  // Refused rather than re-stamped: the first exclusion is the one that happened, and
  // overwriting its actor and reason would lose who actually made the call.
  if (existing.rows[0].excluded_at !== null) throw new ExampleAlreadyExcludedError(exampleId);

  await db.query(
    'update word_examples set excluded_by = $1, excluded_at = now(), excluded_reason = $2 where example_id = $3',
    [excludedBy, reason.trim(), exampleId],
  );
}

// handlers/applyDefinitionDecision.ts
//
// Backs POST /decisions/definition - a curator's direct decision on the
// definition axis (see generate_diagnostics.py's check_definition). Unlike
// the spelling axis, this is fully self-contained - no Kaikki lexicon
// access is needed, since 'custom' text is authored by the human, and
// 'confirm' never changes content at all (it just blesses whatever
// golden_record.definition already holds as reviewed).

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';

export interface ApplyDefinitionDecisionInput {
  definitionAction: 'confirm' | 'custom';
  definitionText?: string;
  /** Which Kaikki record's glosses this definition is sourced from - lets
   * a curator manually override resolveDefinitionSource's automatic
   * choice (e.g. redirecting away from a cross-reference record, or
   * picking an entirely different Kaikki entry via manual search) rather
   * than only ever accepting whatever it auto-resolved. Read back by
   * getDefinitionReview.ts's loadAxisOverride - this was previously a
   * read-only field with no way to actually set it. */
  definitionSourceForm?: string;
  note?: string;
}

export class MissingDefinitionTextError extends Error {
  constructor() {
    super("definitionText is required when definitionAction is 'custom'");
    this.name = 'MissingDefinitionTextError';
  }
}

export async function applyDefinitionDecision(
  pool: pg.Pool,
  wordId: string,
  input: ApplyDefinitionDecisionInput,
  decidedBy: string,
): Promise<void> {
  if (input.definitionAction === 'custom' && !input.definitionText) {
    throw new MissingDefinitionTextError();
  }

  await withTransaction(pool, (client) => applyDefinitionDecisionInTransaction(client, wordId, input, decidedBy));
}

/** Exported so approveContribution.ts can compose this into its own single
 * transaction, rather than calling applyDefinitionDecision (which would
 * open a second, separate transaction). */
export async function applyDefinitionDecisionInTransaction(
  client: Queryable,
  wordId: string,
  input: ApplyDefinitionDecisionInput,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if ((existing.rowCount ?? 0) === 0) {
    throw new WordNotFoundError(wordId);
  }

  if (input.definitionAction === 'custom') {
    await client.query('update golden_record set definition = $1, updated_at = now(), updated_by = $2 where word_id = $3', [
      input.definitionText,
      decidedBy,
      wordId,
    ]);
  }

  const decision = {
    definitionAction: input.definitionAction,
    definitionText: input.definitionText,
    definitionSourceForm: input.definitionSourceForm,
  };
  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by)
     values ($1, 'definition', $2, $3, $4)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by, decided_at = now()`,
    [wordId, decision, input.note ?? null, decidedBy],
  );
}

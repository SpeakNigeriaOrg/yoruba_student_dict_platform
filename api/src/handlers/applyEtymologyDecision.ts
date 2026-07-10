// handlers/applyEtymologyDecision.ts
//
// Backs POST /decisions/etymology - a curator's direct decision on the
// etymology/components axis (see generate_diagnostics.py's
// components_axis_fields). Fully self-contained like the definition axis:
// the client has already resolved each Kaikki-proposed component form to a
// real word_id (via componentsAxis.ts, using its own held copy of the
// lexicon) - this handler just needs to validate those word_ids actually
// exist, exactly like createPhrase.ts's strict check.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';

export type ComponentsAction = 'confirm_atomic' | 'confirm_existing' | 'reject_proposed' | 'accept_proposed' | 'custom';

export interface ApplyEtymologyDecisionInput {
  componentsAction: ComponentsAction;
  components?: string[];
  note?: string;
}

export class ComponentsRequiredError extends Error {
  constructor() {
    super("components is required (and non-empty) when componentsAction is 'accept_proposed' or 'custom'");
    this.name = 'ComponentsRequiredError';
  }
}

export class ComponentsNotFoundError extends Error {
  constructor(public readonly missingWordIds: string[]) {
    super(`component word_id(s) not found in golden_record: ${missingWordIds.join(', ')}`);
    this.name = 'ComponentsNotFoundError';
  }
}

// Only these two actions replace golden_record_components' content - the
// other three (confirm_atomic/confirm_existing/reject_proposed) leave
// whatever's currently there untouched and just record the review.
const CONTENT_CHANGING_ACTIONS = new Set<ComponentsAction>(['accept_proposed', 'custom']);

export async function applyEtymologyDecision(
  pool: pg.Pool,
  wordId: string,
  input: ApplyEtymologyDecisionInput,
  decidedBy: string,
): Promise<void> {
  if (CONTENT_CHANGING_ACTIONS.has(input.componentsAction) && (!input.components || input.components.length === 0)) {
    throw new ComponentsRequiredError();
  }

  await withTransaction(pool, (client) => applyInTransaction(client, wordId, input, decidedBy));
}

async function applyInTransaction(
  client: Queryable,
  wordId: string,
  input: ApplyEtymologyDecisionInput,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if ((existing.rowCount ?? 0) === 0) {
    throw new WordNotFoundError(wordId);
  }

  if (CONTENT_CHANGING_ACTIONS.has(input.componentsAction)) {
    const components = input.components ?? [];
    const foundRows = await client.query<{ word_id: string }>('select word_id from golden_record where word_id = any($1)', [
      components,
    ]);
    const foundIds = new Set(foundRows.rows.map((r) => r.word_id));
    const missing = components.filter((c) => !foundIds.has(c));
    if (missing.length > 0) {
      throw new ComponentsNotFoundError(missing);
    }

    await client.query('delete from golden_record_components where word_id = $1', [wordId]);
    for (const [position, componentWordId] of components.entries()) {
      await client.query(
        'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, $2, $3)',
        [wordId, position, componentWordId],
      );
    }
    await client.query('update golden_record set updated_at = now(), updated_by = $1 where word_id = $2', [
      decidedBy,
      wordId,
    ]);
  }

  const decision = { componentsAction: input.componentsAction, components: input.components };
  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by)
     values ($1, 'etymology', $2, $3, $4)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by, decided_at = now()`,
    [wordId, decision, input.note ?? null, decidedBy],
  );
}

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
import {
  fingerprintOutcome,
  resolveEtymologyOutcome,
  type ComponentsAction,
  type EtymologyOutcome,
} from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';

// Re-exported rather than redeclared: shared/src/consensus.ts owns this union
// now, since resolveEtymologyOutcome has to switch on it. Two independent
// declarations would be free to drift apart, and a file importing both would
// not compile.
export type { ComponentsAction };

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

  await withTransaction(pool, (client) => applyEtymologyDecisionInTransaction(client, wordId, input, decidedBy));
}

/** Exported so approveContribution.ts can compose this into its own single
 * transaction, rather than calling applyEtymologyDecision (which would
 * open a second, separate transaction). */
export async function applyEtymologyDecisionInTransaction(
  client: Queryable,
  wordId: string,
  input: ApplyEtymologyDecisionInput,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if ((existing.rowCount ?? 0) === 0) {
    throw new WordNotFoundError(wordId);
  }

  // Read before any write below, so the fingerprint at the end describes the
  // state this decision was made against - the same freeze-at-observation rule
  // contributions follow.
  const observed = await client.query<{ component_word_id: string }>(
    'select component_word_id from golden_record_components where word_id = $1 order by component_position',
    [wordId],
  );
  const observedComponents = observed.rows.map((r) => r.component_word_id);

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
    await resyncPhraseFromComponents(client, wordId, components, decidedBy);
  }

  const decision = { componentsAction: input.componentsAction, components: input.components };
  const outcome = resolveEtymologyOutcome({ components: observedComponents }, input);
  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by, value_fingerprint)
     values ($1, 'etymology', $2, $3, $4, $5)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by,
       decided_at = now(), value_fingerprint = excluded.value_fingerprint`,
    [wordId, decision, input.note ?? null, decidedBy, fingerprintOutcome(outcome)],
  );
}

/** A phrase's spelling and syllables are DERIVED from its components, so changing the components
 * has to change them too, in the same transaction.
 *
 * createPhrase builds both at authoring time - display_text is the components' spellings joined by
 * spaces and syllables is their syllables concatenated (see AddWord's phrase tab, which is what
 * posts them). Nothing re-derived them afterwards, so editing a phrase's word list on the etymology
 * axis left the phrase spelled as its OLD parts. That is not a cosmetic drift: publish compares a
 * recording's frozen recorded_display_text/recorded_syllables to these columns with exact equality,
 * so a silent respell here takes the phrase's audio out of the game.
 *
 * A no-op for ordinary words, whose spelling is authored rather than derived - which is why the
 * entry_type check is inside this function rather than at the call site: there is exactly one place
 * that has to remember. */
async function resyncPhraseFromComponents(
  client: Queryable,
  wordId: string,
  components: string[],
  decidedBy: string,
): Promise<void> {
  const { rows } = await client.query<{ entry_type: 'phrase' | null }>(
    'select entry_type from golden_record where word_id = $1',
    [wordId],
  );
  if (rows[0]?.entry_type !== 'phrase') return;
  // An empty component list cannot describe a phrase, and joining nothing would blank its spelling.
  // Left alone rather than emptied - the decision row still records what was submitted.
  if (components.length === 0) return;

  const partRows = await client.query<{ word_id: string; display_text: string; syllables: string[] }>(
    'select word_id, display_text, syllables from golden_record where word_id = any($1)',
    [components],
  );
  const byId = new Map(partRows.rows.map((r) => [r.word_id, r]));
  // In the submitted order, not the query's - the order IS the phrase.
  const parts = components.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined);
  if (parts.length !== components.length) return;

  await client.query(
    'update golden_record set display_text = $1, syllables = $2, updated_at = now(), updated_by = $3 where word_id = $4',
    [parts.map((p) => p.display_text).join(' '), parts.flatMap((p) => p.syllables), decidedBy, wordId],
  );
}

/** Writes a consensus OUTCOME as the golden etymology decision - the etymology
 * counterpart of applyEntryOutcomeInTransaction. Replaces the component list
 * with the agreed one and records the settled decision. */
export async function applyEtymologyOutcomeInTransaction(
  client: Queryable,
  wordId: string,
  outcome: EtymologyOutcome,
  note: string | null,
  decidedBy: string,
): Promise<void> {
  const existing = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if ((existing.rowCount ?? 0) === 0) {
    throw new WordNotFoundError(wordId);
  }

  // Same existence check the action path applies - a consensus can still name a
  // component word that has since been removed.
  if (outcome.components.length > 0) {
    const found = await client.query<{ word_id: string }>('select word_id from golden_record where word_id = any($1)', [
      outcome.components,
    ]);
    const foundIds = new Set(found.rows.map((r) => r.word_id));
    const missing = outcome.components.filter((c) => !foundIds.has(c));
    if (missing.length > 0) throw new ComponentsNotFoundError(missing);
  }

  await client.query('delete from golden_record_components where word_id = $1', [wordId]);
  for (const [position, componentWordId] of outcome.components.entries()) {
    await client.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, $2, $3)',
      [wordId, position, componentWordId],
    );
  }
  await client.query('update golden_record set updated_at = now(), updated_by = $1 where word_id = $2', [decidedBy, wordId]);
  // Both write paths, or a phrase settled by consensus keeps the spelling of its old parts.
  await resyncPhraseFromComponents(client, wordId, outcome.components, decidedBy);

  await client.query(
    `insert into word_decisions (word_id, axis, decision, note, decided_by, value_fingerprint)
     values ($1, 'etymology', $2, $3, $4, $5)
     on conflict (word_id, axis) do update set
       decision = excluded.decision, note = excluded.note, decided_by = excluded.decided_by,
       decided_at = now(), value_fingerprint = excluded.value_fingerprint`,
    [
      wordId,
      outcome.atomic
        ? { componentsAction: 'confirm_atomic' }
        : { componentsAction: 'confirm_existing', components: outcome.components },
      note,
      decidedBy,
      fingerprintOutcome(outcome),
    ],
  );
}

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

/** A phrase's composition is a fact about it, not an optional annotation.
 *
 * A word and a phrase are the same kind of thing - a spelling, plus the possibility of an
 * etymology. What makes something a phrase is that its etymology is already KNOWN: it is these
 * words, in this order. So a phrase with no components is not an entry awaiting review, it is a
 * record contradicting itself.
 *
 * createPhrase has always refused an empty list, and EtymologyReview has always hidden the "It
 * has no parts" button for a phrase - but the server accepted confirm_atomic from anyone who
 * asked, so the rule lived entirely in a screen. That is the shape of advisory check 0017 was
 * written to remove: a read-then-write with nothing behind it is a convention, not an invariant.
 *
 * Note what this is NOT: a claim that only phrases have components. A hyphenated compound
 * (`ilé-ìwé` from `ilé` + `ìwé`) has them too, and none of the 103 ordinary words in production
 * records any yet. The rule is that a phrase must have them. */
export class PhraseNeedsComponentsError extends Error {
  constructor(public readonly wordId: string) {
    super(
      `'${wordId}' is a phrase, so it is composed of words by definition and cannot be recorded ` +
        `as having no parts - name the words it is made of, in order`,
    );
    this.name = 'PhraseNeedsComponentsError';
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
  const existing = await client.query<{ entry_type: 'phrase' | null }>(
    'select entry_type from golden_record where word_id = $1',
    [wordId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    throw new WordNotFoundError(wordId);
  }
  const isPhrase = existing.rows[0].entry_type === 'phrase';

  // Read before any write below, so the fingerprint at the end describes the
  // state this decision was made against - the same freeze-at-observation rule
  // contributions follow.
  const observed = await client.query<{ component_word_id: string }>(
    'select component_word_id from golden_record_components where word_id = $1 order by component_position',
    [wordId],
  );
  const observedComponents = observed.rows.map((r) => r.component_word_id);

  // Checked against the OUTCOME rather than against the action, so it cannot be reached by a
  // route nobody thought of. confirm_atomic is the obvious way to empty a phrase; confirming or
  // rejecting on a phrase that already has none is the way that does it without saying so, and
  // that is the state `ẹ jọ̀ọ́` is in today.
  const resultingComponents = CONTENT_CHANGING_ACTIONS.has(input.componentsAction)
    ? (input.components ?? [])
    : observedComponents;
  if (isPhrase && (input.componentsAction === 'confirm_atomic' || resultingComponents.length === 0)) {
    throw new PhraseNeedsComponentsError(wordId);
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

// ---------------------------------------------------------------------------
// A phrase's spelling is NOT re-derived here, and that is a deliberate reversal
// ---------------------------------------------------------------------------
// This used to end with resyncPhraseFromComponents, which rewrote a phrase's display_text to
// its components' spellings joined by spaces and its syllables to theirs concatenated, on
// every component edit. It was written to fix a real bug - editing a phrase's word list left
// it spelled as its OLD parts, and publish compares a recording's frozen
// recorded_display_text to this column with exact equality, so a stale spelling takes the
// phrase's audio out of the game.
//
// But it fixed that bug by making the components the ONLY source of a phrase's spelling,
// which promoted "a phrase is a sequence of words" into "a phrase's spelling is the
// concatenation of its words' spellings". Yoruba breaks that constantly, and upstream's own
// data says so: `o ṣé` has canonical_form `o ṣé` with IPA /ō ʃé/ while its parts are `o` and
// `ṣe`; `muti` is {{contraction|yo|mu|ọtí}}. Under this rule those phrases could not be
// stored correctly at all, and 0017 blocks the workaround of minting a second word to hold
// the changed tone.
//
// So the spelling is authored (AddWord's phrase tab composes it on a tone grid) and this
// function is gone. The original bug does not return: nothing derives the spelling, so
// nothing can leave it derived-from-something-stale. What replaces the guarantee is a
// report - shared/src/phraseSpelling.ts's checkPhraseSpelling, shown where a phrase is
// authored and in the Wiktionary export - because a spelling that differs from its parts is
// usually a real linguistic fact and occasionally a typo, and only a human can tell which.

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
  const existing = await client.query<{ entry_type: 'phrase' | null }>(
    'select entry_type from golden_record where word_id = $1',
    [wordId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    throw new WordNotFoundError(wordId);
  }

  // Both write paths, or the rule holds only for whoever came through the front door. A
  // consensus that agreed a phrase has no parts agreed to something that cannot be true, and
  // this path writes the component list directly.
  if (existing.rows[0].entry_type === 'phrase' && (outcome.atomic || outcome.components.length === 0)) {
    throw new PhraseNeedsComponentsError(wordId);
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
  // No respelling here either - see the note above the action path. A consensus is about which
  // words a phrase is built from; it carries no opinion about how the phrase is spelled, and
  // rewriting the spelling from it would apply an opinion nobody voted on.

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

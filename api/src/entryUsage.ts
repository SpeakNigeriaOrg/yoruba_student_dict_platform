// entryUsage.ts
//
// Part of speech, usage labels and the only-in-derived-terms flag (0029), as the entry axis reads
// and writes them. One module because three paths must do this identically - submitting a vote
// (submitContribution), a curator's direct decision (applyEntryDecisionInTransaction) and
// confirming a consensus (applyEntryOutcomeInTransaction) - and any drift between what a vote was
// resolved against and what applying it writes is the permanent-dissent bug consensus.ts
// describes: a stored fingerprint no later vote can ever equal.

import {
  acceptsOnlyInDerivedTerms,
  canonicalUsageLabels,
  isKnownPartOfSpeech,
  isKnownUsageLabel,
  type EntryOutcome,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from './db.js';

/** Select-list fragment. Requires `golden_record g` left-joined to `upstream_citations c`.
 *
 * pos is RESOLVED - the 0018 override, else the pin's - because that is what a reviewer is shown
 * and therefore what confirming it asserts. */
export const ENTRY_USAGE_COLUMNS = `coalesce(g.pos, c.pin ->> 'pos') as resolved_pos, g.usage_labels, g.only_in_derived_terms`;

export interface EntryUsageRow {
  resolved_pos: string | null;
  usage_labels: string[];
  only_in_derived_terms: boolean;
}

export function usageObserved(row: EntryUsageRow): {
  pos: string | null;
  usageLabels: string[];
  onlyInDerivedTerms: boolean;
} {
  return { pos: row.resolved_pos, usageLabels: row.usage_labels, onlyInDerivedTerms: row.only_in_derived_terms };
}

export interface EntryUsageInput {
  posAction?: 'confirm' | 'set';
  pos?: string;
  usageLabelsAction?: 'confirm' | 'set';
  usageLabels?: string[];
  onlyInDerivedTermsAction?: 'confirm' | 'set';
  onlyInDerivedTerms?: boolean;
}

export class InvalidEntryUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntryUsageError';
  }
}

/** Business rules for the three 'set' actions. 'confirm' is never checked against the vocabulary:
 * a legacy pos typed before the closed list existed must stay confirmable, or an old entry would
 * become unreviewable for a reason unrelated to the review (see isKnownPartOfSpeech). */
export function validateEntryUsageInput(input: EntryUsageInput): void {
  if (input.posAction === 'set' && (!input.pos || !isKnownPartOfSpeech(input.pos))) {
    throw new InvalidEntryUsageError(`posAction 'set' needs a known part of speech, got '${input.pos ?? ''}'`);
  }
  if (input.usageLabelsAction === 'set') {
    const unknown = (input.usageLabels ?? []).filter((l) => !isKnownUsageLabel(l));
    if (unknown.length > 0) throw new InvalidEntryUsageError(`unknown usage label(s): ${unknown.join(', ')}`);
  }
  if (input.onlyInDerivedTermsAction === 'set' && typeof input.onlyInDerivedTerms !== 'boolean') {
    throw new InvalidEntryUsageError("onlyInDerivedTermsAction 'set' needs onlyInDerivedTerms: true or false");
  }
}

// ---------------------------------------------------------------------------
// At creation (createWord, createPhrase)
// ---------------------------------------------------------------------------
// The same two facts, said by whoever adds the word. Written straight onto the new row, and the
// author's vote (authoringVote.ts: keep_ours + confirm, resolved against the row just written)
// then carries them - so the author's position includes them without a second construction.

export interface CreationUsage {
  usageLabels?: string[];
  onlyInDerivedTerms?: boolean;
}

/** Off the wire. Absent means "nothing to say" - no labels, flag off - which is what every word
 * created before 0029 said. Unknown labels are refused rather than dropped: the form only offers
 * the closed list, so an unknown one is a client bug worth hearing about. */
export function parseCreationUsage(body: Record<string, unknown>): CreationUsage {
  const out: CreationUsage = {};
  if (body.usageLabels !== undefined) {
    if (!Array.isArray(body.usageLabels) || !body.usageLabels.every((l) => typeof l === 'string')) {
      throw new InvalidEntryUsageError('usageLabels must be an array of strings if provided');
    }
    const unknown = body.usageLabels.filter((l) => !isKnownUsageLabel(l));
    if (unknown.length > 0) throw new InvalidEntryUsageError(`unknown usage label(s): ${unknown.join(', ')}`);
    out.usageLabels = canonicalUsageLabels(body.usageLabels);
  }
  if (body.onlyInDerivedTerms !== undefined) {
    if (typeof body.onlyInDerivedTerms !== 'boolean') {
      throw new InvalidEntryUsageError('onlyInDerivedTerms must be a boolean if provided');
    }
    out.onlyInDerivedTerms = body.onlyInDerivedTerms;
  }
  return out;
}

/** Writes CreationUsage onto a row created in this transaction. Must run AFTER the citation is
 * written: the flag is checked against the RESOLVED pos, and for a cited word that is the pin's.
 *
 * A flag on an affix or a character is refused, not silently cleared. The form hides the box for
 * those, so reaching here means a client that did not - and quietly storing something other than
 * what was sent would be exactly the kind of mismatch the author could never see. */
export async function writeCreationUsageInTransaction(
  client: Queryable,
  wordId: string,
  usage: CreationUsage,
): Promise<void> {
  const labels = usage.usageLabels ?? [];
  const flag = usage.onlyInDerivedTerms === true;
  if (labels.length === 0 && !flag) return;

  if (flag) {
    const r = await client.query<{ resolved_pos: string | null }>(
      `select coalesce(g.pos, c.pin ->> 'pos') as resolved_pos
       from golden_record g
       left join upstream_citations c on c.word_id = g.word_id
       where g.word_id = $1`,
      [wordId],
    );
    const pos = r.rows[0]?.resolved_pos ?? null;
    if (!acceptsOnlyInDerivedTerms(pos)) {
      throw new InvalidEntryUsageError(
        `'survives only inside other words' does not apply to a ${pos} - an affix or a letter never was a separate word`,
      );
    }
  }
  await client.query('update golden_record set usage_labels = $1, only_in_derived_terms = $2 where word_id = $3', [
    labels,
    flag,
    wordId,
  ]);
}

/** Makes the record say what `outcome` says about usage, writing only what differs.
 *
 * Called AFTER any re-citation in the same decision, and the ordering is the point: the pos a
 * record resolves to depends on the pin, and re-citing changes the pin. So pos is written as
 * whatever override makes coalesce(pos, pin.pos) equal the outcome - null when the pin already
 * says it, so upstream's answer keeps winning wherever we agree with it. A confirm that re-cited
 * the word therefore pins the pos the reviewer actually saw, rather than silently adopting the new
 * etymology's.
 *
 * Outcomes with no usage keys (legacy, pre-0029) change nothing - they assert nothing about it. */
export async function writeEntryUsageInTransaction(
  client: Queryable,
  wordId: string,
  outcome: EntryOutcome,
  decidedBy: string,
): Promise<void> {
  if (outcome.pos === undefined && outcome.usageLabels === undefined && outcome.onlyInDerivedTerms === undefined) return;

  const current = await client.query<{
    pos: string | null;
    pin_pos: string | null;
    usage_labels: string[];
    only_in_derived_terms: boolean;
  }>(
    `select g.pos, c.pin ->> 'pos' as pin_pos, g.usage_labels, g.only_in_derived_terms
     from golden_record g
     left join upstream_citations c on c.word_id = g.word_id
     where g.word_id = $1`,
    [wordId],
  );
  const row = current.rows[0];
  if (!row) return;

  // A null outcome pos cannot be expressed as an override when the pin has one, and asserts nothing
  // worth overriding with - so it leaves the column alone.
  const pos =
    outcome.pos === undefined || outcome.pos === null ? row.pos : outcome.pos === row.pin_pos ? null : outcome.pos;
  const usageLabels = outcome.usageLabels ?? row.usage_labels;
  const onlyInDerivedTerms = outcome.onlyInDerivedTerms ?? row.only_in_derived_terms;

  const labelsDiffer =
    usageLabels.length !== row.usage_labels.length || usageLabels.some((l, i) => l !== row.usage_labels[i]);
  if (pos === row.pos && !labelsDiffer && onlyInDerivedTerms === row.only_in_derived_terms) return;

  await client.query(
    `update golden_record
     set pos = $1, usage_labels = $2, only_in_derived_terms = $3, updated_at = now(), updated_by = $4
     where word_id = $5`,
    [pos, usageLabels, onlyInDerivedTerms, decidedBy, wordId],
  );
}

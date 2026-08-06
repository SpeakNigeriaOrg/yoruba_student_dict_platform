// handlers/approveContribution.ts
//
// Backs POST /contributions/{id}/approve - curator-only, and since 0013 this
// means ONE thing only: approving a 'new_entry' proposal, which inserts the
// word createWord.ts/createPhrase.ts would insert, composed into ONE
// transaction alongside marking the contribution approved, so a contribution
// can never end up applied-but-still-pending or approved-but-never-applied.
//
// The entry and etymology axes used to be approvable here too, applying one
// volunteer's proposed_value verbatim as the decision. They no longer are: a
// contribution on those axes is evidence, and settling them means confirming
// the synthesis across everyone who weighed in (confirmConsensus.ts). Reaching
// this handler with one of those axes is a caller bug, not a fallback, so it
// throws rather than silently applying a single opinion.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { createPhraseInTransaction } from './createPhrase.js';
import { createWordInTransaction } from './createWord.js';
import type { NewEntryProposedValue } from './submitContribution.js';

export class ContributionNotFoundError extends Error {
  constructor(public readonly contributionId: string) {
    super(`contribution '${contributionId}' not found`);
    this.name = 'ContributionNotFoundError';
  }
}

export class ContributionAlreadyReviewedError extends Error {
  constructor(
    public readonly contributionId: string,
    public readonly status: string,
  ) {
    super(`contribution '${contributionId}' has already been reviewed (status: ${status})`);
    this.name = 'ContributionAlreadyReviewedError';
  }
}

/** 'spelling' and 'definition' are retained here because contributions is
 * HISTORY: 0011_merge_entry_axis.sql rejected every pending row on those
 * axes but deliberately left already-reviewed rows readable under the axis
 * they were actually submitted under. They are unapprovable, not unknown -
 * see LegacyAxisNotApprovableError below. */
type ContributionAxis = 'entry' | 'etymology' | 'new_entry' | 'spelling' | 'definition';

/** Since 0013 an entry/etymology contribution is EVIDENCE, not a proposal
 * awaiting a verdict, so approving one individually is no longer a coherent
 * act - it would apply one volunteer's answer as the truth while ignoring
 * everyone else who weighed in on the same word. Those axes are settled through
 * confirmConsensus, which ratifies the synthesis.
 *
 * 'new_entry' is genuinely different and keeps this path: proposing a word that
 * does not exist yet is authorship, not a vote on an existing word's value.
 * There is nothing to reach consensus with. */
export class ConsensusAxisNotIndividuallyApprovableError extends Error {
  constructor(
    public readonly contributionId: string,
    public readonly axis: string,
  ) {
    super(
      `contribution '${contributionId}' is on the '${axis}' axis, which is decided by confirming the consensus across all contributors (POST /consensus/confirm), not by approving one submission`,
    );
    this.name = 'ConsensusAxisNotIndividuallyApprovableError';
  }
}

/** A pending contribution on a pre-merge axis. Should be unreachable -
 * 0011 rejected all of them and nothing writes those values anymore - but
 * surfaced loudly rather than silently skipped, because the switch below
 * previously had no default: an unhandled axis would mark the contribution
 * approved while applying nothing, which is the worst available outcome. */
export class LegacyAxisNotApprovableError extends Error {
  constructor(contributionId: string, axis: string) {
    super(
      `contribution '${contributionId}' is on the pre-merge '${axis}' axis and cannot be approved - spelling and definition are now decided together as one 'entry' contribution, which must be resubmitted`,
    );
    this.name = 'LegacyAxisNotApprovableError';
  }
}

/** A 'new_entry' word proposal with no cited etymology. Only reachable for a
 * contribution submitted before citations existed, since parseNewEntryInput now
 * refuses one at the HTTP edge - hence the resubmit instruction rather than a
 * repair path. */
export class CitationMissingOnNewEntryError extends Error {
  constructor(proposedWordId: string) {
    super(
      `proposed word '${proposedWordId}' cites no Wiktionary etymology and cannot be approved - a word's identity is the ` +
        `etymology it cites, and that cannot be recovered from its spelling afterwards. Resubmit it, picking the etymology`,
    );
    this.name = 'CitationMissingOnNewEntryError';
  }
}

interface ContributionRow {
  contribution_id: string;
  word_id: string | null;
  axis: ContributionAxis;
  proposed_value: unknown;
  status: string;
}

export async function approveContribution(pool: pg.Pool, contributionId: string, approvedBy: string): Promise<void> {
  await withTransaction(pool, (client) => approveInTransaction(client, contributionId, approvedBy));
}

async function approveInTransaction(client: Queryable, contributionId: string, approvedBy: string): Promise<void> {
  // `for update` locks the row for the rest of this transaction, so a
  // second concurrent approval attempt for the same contribution blocks
  // until this one commits (and then sees status !== 'active') rather
  // than racing to apply the same proposal twice.
  const result = await client.query<ContributionRow>(
    "select contribution_id, word_id, axis, proposed_value, status from contributions where contribution_id = $1 for update",
    [contributionId],
  );
  const contribution = result.rows[0];
  if (!contribution) {
    throw new ContributionNotFoundError(contributionId);
  }
  // 'active' is the un-reviewed state since 0013 - 'pending' no longer exists,
  // so comparing against it made EVERY approval fail as already-reviewed.
  if (contribution.status !== 'active') {
    throw new ContributionAlreadyReviewedError(contributionId, contribution.status);
  }

  switch (contribution.axis) {
    case 'entry':
    case 'etymology':
      throw new ConsensusAxisNotIndividuallyApprovableError(contribution.contribution_id, contribution.axis);
    case 'spelling':
    case 'definition':
      throw new LegacyAxisNotApprovableError(contribution.contribution_id, contribution.axis);
    case 'new_entry':
      await approveNewEntry(client, contribution.proposed_value as NewEntryProposedValue, approvedBy);
      break;
  }

  // 'applied', not 'approved': 0013 replaced the old verdict vocabulary, and
  // this is the terminal state for an accepted new_entry - its word now exists.
  // reviewed_by/reviewed_at record who accepted it, which is the one
  // per-contribution review the model still has.
  await client.query(
    "update contributions set status = 'applied', reviewed_by = $1, reviewed_at = now() where contribution_id = $2",
    [approvedBy, contributionId],
  );
}

async function approveNewEntry(client: Queryable, proposedValue: NewEntryProposedValue, approvedBy: string): Promise<void> {
  if (proposedValue.type === 'phrase') {
    await createPhraseInTransaction(
      client,
      {
        wordId: proposedValue.proposedWordId,
        displayText: proposedValue.displayText,
        syllables: proposedValue.syllables,
        components: proposedValue.components ?? [],
      },
      approvedBy,
    );
  } else {
    // proposed_value is a jsonb cast, so the compiler guarantees nothing about
    // it - this is the real enforcement that an approved word arrives cited.
    // Fail loudly rather than defaulting to an exemption: an uncited word cannot
    // be repaired later from its spelling (one spelling maps to several
    // etymologies), so a silent default would be unrecoverable data loss.
    if (!proposedValue.citation) {
      throw new CitationMissingOnNewEntryError(proposedValue.proposedWordId);
    }
    await createWordInTransaction(
      client,
      {
        wordId: proposedValue.proposedWordId,
        displayText: proposedValue.displayText,
        syllables: proposedValue.syllables,
        citation: proposedValue.citation,
      },
      approvedBy,
    );
  }
}

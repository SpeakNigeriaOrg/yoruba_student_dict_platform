// handlers/approveContribution.ts
//
// Backs POST /contributions/{id}/approve - curator-only. Applies a
// pending contribution's proposed_value exactly like the curator's own
// direct decision would (reusing the same *InTransaction functions each
// axis's apply* handler exports), plus (for 'new_entry') the same insert
// createWord.ts/createPhrase.ts perform - all composed into ONE
// transaction alongside marking the contribution approved, so a
// contribution can never end up applied-but-still-pending or
// approved-but-never-applied.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { applyDefinitionDecisionInTransaction, type ApplyDefinitionDecisionInput } from './applyDefinitionDecision.js';
import { applyEtymologyDecisionInTransaction, type ApplyEtymologyDecisionInput } from './applyEtymologyDecision.js';
import { applySpellingDecisionInTransaction, type ApplySpellingDecisionInput } from './applySpellingDecision.js';
import { createPhraseInTransaction } from './createPhrase.js';
import { createWord } from './createWord.js';
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

type ContributionAxis = 'spelling' | 'definition' | 'etymology' | 'new_entry';

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
  // until this one commits (and then sees status !== 'pending') rather
  // than racing to apply the same proposal twice.
  const result = await client.query<ContributionRow>(
    "select contribution_id, word_id, axis, proposed_value, status from contributions where contribution_id = $1 for update",
    [contributionId],
  );
  const contribution = result.rows[0];
  if (!contribution) {
    throw new ContributionNotFoundError(contributionId);
  }
  if (contribution.status !== 'pending') {
    throw new ContributionAlreadyReviewedError(contributionId, contribution.status);
  }

  switch (contribution.axis) {
    case 'spelling':
      await applySpellingDecisionInTransaction(
        client,
        requireContributionWordId(contribution),
        contribution.proposed_value as ApplySpellingDecisionInput,
        approvedBy,
      );
      break;
    case 'definition':
      await applyDefinitionDecisionInTransaction(
        client,
        requireContributionWordId(contribution),
        contribution.proposed_value as ApplyDefinitionDecisionInput,
        approvedBy,
      );
      break;
    case 'etymology':
      await applyEtymologyDecisionInTransaction(
        client,
        requireContributionWordId(contribution),
        contribution.proposed_value as ApplyEtymologyDecisionInput,
        approvedBy,
      );
      break;
    case 'new_entry':
      await approveNewEntry(client, contribution.proposed_value as NewEntryProposedValue, approvedBy);
      break;
  }

  await client.query(
    "update contributions set status = 'approved', reviewed_by = $1, reviewed_at = now() where contribution_id = $2",
    [approvedBy, contributionId],
  );
}

function requireContributionWordId(contribution: ContributionRow): string {
  if (!contribution.word_id) {
    // Should be impossible given contributions_new_entry_word_id_null -
    // surfaced as a real error rather than a silent `!` assertion in case
    // that invariant is ever violated (e.g. a hand-edited row).
    throw new Error(
      `contribution '${contribution.contribution_id}' has axis '${contribution.axis}' but no word_id`,
    );
  }
  return contribution.word_id;
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
    await createWord(
      client,
      { wordId: proposedValue.proposedWordId, displayText: proposedValue.displayText, syllables: proposedValue.syllables },
      approvedBy,
    );
  }
}

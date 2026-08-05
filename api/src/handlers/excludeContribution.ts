// handlers/excludeContribution.ts
//
// Backs POST /contributions/{id}/exclude - curator-only. Replaces
// rejectContribution.
//
// The difference is not cosmetic. Rejecting was a verdict on a person's
// submission: "your proposal is declined." Excluding sets a row aside from the
// TALLY without touching what it says - for spam, abuse, a duplicate account,
// or test data. A contribution is evidence about a word, and evidence that
// turns out to be wrong is still evidence someone offered; deleting it, or
// pretending it was never made, is the one thing this model must not do.
//
// So the row is retained in full - proposed_value, resolved_value,
// value_fingerprint, submitted_by, submitted_at all untouched - and only
// `status` moves. 0013 enforces that exclusion metadata may exist ONLY on
// excluded rows, so a curator's reason can never be silently attached to a
// contribution that still counts.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { ContributionNotFoundError } from './approveContribution.js';

export class ContributionNotActiveError extends Error {
  constructor(
    public readonly contributionId: string,
    public readonly status: string,
  ) {
    super(`contribution '${contributionId}' is not active (status: ${status}) and cannot be excluded`);
    this.name = 'ContributionNotActiveError';
  }
}

export async function excludeContribution(
  pool: pg.Pool,
  contributionId: string,
  excludedBy: string,
  reason?: string,
): Promise<void> {
  await withTransaction(pool, (client) => excludeInTransaction(client, contributionId, excludedBy, reason));
}

async function excludeInTransaction(
  client: Queryable,
  contributionId: string,
  excludedBy: string,
  reason?: string,
): Promise<void> {
  // Same row lock as approveContribution: a second concurrent exclusion blocks
  // and then sees status !== 'active', rather than both proceeding.
  const result = await client.query<{ status: string }>(
    'select status from contributions where contribution_id = $1 for update',
    [contributionId],
  );
  const contribution = result.rows[0];
  if (!contribution) {
    throw new ContributionNotFoundError(contributionId);
  }
  // Superseded rows are already out of the tally, and re-excluding an excluded
  // row would overwrite the original reason and actor.
  if (contribution.status !== 'active') {
    throw new ContributionNotActiveError(contributionId, contribution.status);
  }

  await client.query(
    `update contributions
     set status = 'excluded', excluded_by = $1, excluded_at = now(), excluded_reason = $2
     where contribution_id = $3`,
    [excludedBy, reason ?? null, contributionId],
  );
}

// handlers/rejectContribution.ts
//
// Backs POST /contributions/{id}/reject - curator-only. Real gap found
// while building the approval queue UI: contributions.status already
// supports 'rejected' in its check constraint, but nothing ever set it -
// a curator could approve or leave a contribution pending forever, never
// actually decline it. Marks the row rejected without applying its
// proposed_value, mirroring approveContribution.ts's row-locking pattern
// (same "second concurrent review blocks, not races" rationale) without
// needing a full transaction (no content changes to make).

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { ContributionAlreadyReviewedError, ContributionNotFoundError } from './approveContribution.js';

export async function rejectContribution(pool: pg.Pool, contributionId: string, rejectedBy: string): Promise<void> {
  await withTransaction(pool, (client) => rejectInTransaction(client, contributionId, rejectedBy));
}

async function rejectInTransaction(client: Queryable, contributionId: string, rejectedBy: string): Promise<void> {
  const result = await client.query<{ status: string }>(
    'select status from contributions where contribution_id = $1 for update',
    [contributionId],
  );
  const contribution = result.rows[0];
  if (!contribution) {
    throw new ContributionNotFoundError(contributionId);
  }
  if (contribution.status !== 'pending') {
    throw new ContributionAlreadyReviewedError(contributionId, contribution.status);
  }

  await client.query(
    "update contributions set status = 'rejected', reviewed_by = $1, reviewed_at = now() where contribution_id = $2",
    [rejectedBy, contributionId],
  );
}

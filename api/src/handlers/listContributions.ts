// handlers/listContributions.ts
//
// Backs GET /contributions?status=pending - curator-only. Real gap found
// while building the approval queue UI: submitContribution.ts and
// approveContribution.ts both existed, but nothing could list pending
// ones for a curator to review in the first place.

import type { Queryable } from '../db.js';

export interface ContributionListItem {
  contributionId: string;
  wordId: string | null;
  wordDisplayText: string | null;
  axis: 'spelling' | 'definition' | 'etymology' | 'new_entry';
  proposedValue: unknown;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  status: string;
}

export async function listContributions(client: Queryable, status = 'pending'): Promise<ContributionListItem[]> {
  const { rows } = await client.query<{
    contribution_id: string;
    word_id: string | null;
    word_display_text: string | null;
    axis: 'spelling' | 'definition' | 'etymology' | 'new_entry';
    proposed_value: unknown;
    note: string | null;
    submitted_by_username: string;
    submitted_at: string;
    status: string;
  }>(
    `select c.contribution_id, c.word_id, gr.display_text as word_display_text, c.axis, c.proposed_value, c.note,
            u.username as submitted_by_username, c.submitted_at, c.status
     from contributions c
     join users u on u.user_id = c.submitted_by
     left join golden_record gr on gr.word_id = c.word_id
     where c.status = $1
     order by c.submitted_at`,
    [status],
  );
  return rows.map((row) => ({
    contributionId: row.contribution_id,
    wordId: row.word_id,
    wordDisplayText: row.word_display_text,
    axis: row.axis,
    proposedValue: row.proposed_value,
    note: row.note,
    submittedBy: row.submitted_by_username,
    submittedAt: row.submitted_at,
    status: row.status,
  }));
}

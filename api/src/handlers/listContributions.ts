// handlers/listContributions.ts
//
// Backs GET /contributions?status=pending - curator-only. Real gap found
// while building the approval queue UI: submitContribution.ts and
// approveContribution.ts both existed, but nothing could list pending
// ones for a curator to review in the first place.

import type { Queryable } from '../db.js';

/** 'spelling'/'definition' only ever appear on pre-merge rows a curator
 * already reviewed - 0011_merge_entry_axis.sql rejected the pending ones and
 * nothing writes those values anymore. Kept in the union so the history
 * stays listable rather than failing to type. */
export type ContributionAxis = 'entry' | 'etymology' | 'new_entry' | 'spelling' | 'definition';

/** A word whose etymology submission already names the word a 'new_entry' request would
 * create. */
export interface WaitingWord {
  wordId: string | null;
  displayText: string | null;
}

export interface ContributionListItem {
  contributionId: string;
  wordId: string | null;
  wordDisplayText: string | null;
  axis: ContributionAxis;
  proposedValue: unknown;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  status: string;
  /** What is blocked on this request, for 'new_entry' rows; empty on every other axis.
   *
   * The ordering constraint - approve the requested word, THEN confirm the etymology that names
   * it - is already enforced, by ComponentsNotFoundError. What it was not, was legible: a curator
   * met it as a failure at confirmation time with no way to see it coming. Naming the waiting
   * words here turns it into a reason to approve rather than an error to decipher. */
  waitingWords: WaitingWord[];
}

/** Defaults to 'active' - 0013 replaced the pending/approved/rejected verdict
 * vocabulary with one describing a row's standing as evidence, and 'pending'
 * no longer exists.
 *
 * This remains a per-contribution view, but it is no longer the curator's main
 * surface: settling entry/etymology happens through the consensus queue
 * (listConsensus.ts). What this is still for is the 'new_entry' approval queue,
 * inspecting one word's individual contributors, and finding a row to exclude. */
export async function listContributions(client: Queryable, status = 'active'): Promise<ContributionListItem[]> {
  const { rows } = await client.query<{
    contribution_id: string;
    word_id: string | null;
    word_display_text: string | null;
    axis: ContributionAxis;
    proposed_value: unknown;
    note: string | null;
    submitted_by_email: string;
    submitted_at: string;
    status: string;
  }>(
    `select c.contribution_id, c.word_id, gr.display_text as word_display_text, c.axis, c.proposed_value, c.note,
            u.email as submitted_by_email, c.submitted_at, c.status
     from contributions c
     join users u on u.user_id = c.submitted_by
     left join golden_record gr on gr.word_id = c.word_id
     where c.status = $1
     order by c.submitted_at`,
    [status],
  );

  const waiting = rows.some((r) => r.axis === 'new_entry') ? await loadWaitingWords(client) : new Map();

  return rows.map((row) => ({
    contributionId: row.contribution_id,
    wordId: row.word_id,
    wordDisplayText: row.word_display_text,
    axis: row.axis,
    proposedValue: row.proposed_value,
    note: row.note,
    submittedBy: row.submitted_by_email,
    submittedAt: row.submitted_at,
    status: row.status,
    waitingWords:
      row.axis === 'new_entry' ? (waiting.get(proposedWordIdOf(row.proposed_value)) ?? []) : [],
  }));
}

function proposedWordIdOf(proposedValue: unknown): string {
  const id = (proposedValue as { proposedWordId?: unknown } | null)?.proposedWordId;
  return typeof id === 'string' ? id : '';
}

/** Every component word_id named by an ACTIVE etymology contribution, mapped to the words naming
 * it. One query for the whole list rather than one per request.
 *
 * Only contributions can hold a reference to a word that does not exist yet: golden_record_
 * components has a real foreign key, and applyEtymologyDecision refuses a decision naming a
 * missing component. So this is the complete set of things waiting on an approval. */
async function loadWaitingWords(client: Queryable): Promise<Map<string, WaitingWord[]>> {
  const { rows } = await client.query<{ component_word_id: string; word_id: string | null; display_text: string | null }>(
    `select distinct comp.value #>> '{}' as component_word_id, e.word_id, g.display_text
     from contributions e
       cross join lateral jsonb_array_elements(e.proposed_value -> 'components') comp
       left join golden_record g on g.word_id = e.word_id
     where e.axis = 'etymology' and e.status = 'active'
       and jsonb_typeof(e.proposed_value -> 'components') = 'array'`,
  );

  const byComponent = new Map<string, WaitingWord[]>();
  for (const row of rows) {
    if (!row.component_word_id) continue;
    const list = byComponent.get(row.component_word_id) ?? [];
    list.push({ wordId: row.word_id, displayText: row.display_text });
    byComponent.set(row.component_word_id, list);
  }
  return byComponent;
}

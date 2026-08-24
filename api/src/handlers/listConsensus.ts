// handlers/listConsensus.ts
//
// Backs GET /consensus - curator-only. The review queue, one row per
// (word, axis) rather than per contribution.
//
// This replaces listContributions as the curator's working surface. The old
// list asked "which submissions are outstanding?", which made the curator
// adjudicate people one at a time. This asks "what does the evidence say about
// each word?", which is the question that scales and the one worth answering.
//
// Provisional state is DERIVED here, not stored - there is no
// provisional_decisions table and no word_decisions.status. word_decisions
// keeps meaning golden only, so the publish scripts, getEtymologyReview's
// targetSpellingConfirmed lookup, and createAssignments' 'incomplete' scope all
// keep their existing meaning. See 0013's header for the full argument.
//
// Three queries total regardless of how many words are involved, following
// loadAxisDecidedBatch's "2 queries, not 2N" shape.

import {
  summarizeConsensus,
  type ConsensusBucket,
  type ConsensusSummary,
  type ContributionOutcome,
  type ContributionRecord,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import type { DecisionAxis } from '../reviewShared.js';

export interface ConsensusGroup {
  wordId: string;
  displayText: string;
  /** golden_record's current definition, as context for judging the claims. */
  currentDefinition: string | null;
  axis: DecisionAxis;
  /** Present only once a curator has decided. */
  decidedAt: string | null;
  decidedByEmail: string | null;
  summary: ConsensusSummary;
}

/** Buckets a curator would want to act on, in the order they deserve
 * attention. 'golden' and 'none' are excluded by default - a settled word and
 * an untouched one both need nothing. */
const ACTIONABLE: ConsensusBucket[] = ['contested', 'dissent_on_golden', 'ready', 'single'];

const BUCKET_PRIORITY: Record<ConsensusBucket, number> = {
  contested: 0,
  dissent_on_golden: 1,
  ready: 2,
  single: 3,
  golden: 4,
  none: 5,
};

export interface ListConsensusOptions {
  /** Restrict to these buckets. Defaults to everything actionable. */
  buckets?: ConsensusBucket[];
  /** Restrict to one axis, for the bulk-confirm screen. */
  axis?: DecisionAxis;
  /** Restrict to one word, for its dossier - where a curator reads the tally next to
   * everything else known about the word and decides there. Note this widens what the
   * caller will see: a single word's tally is worth showing whatever bucket it falls in,
   * including 'golden', so the dossier must ask for those buckets explicitly. */
  wordId?: string;
}

export async function listConsensus(client: Queryable, options: ListConsensusOptions = {}): Promise<ConsensusGroup[]> {
  const wanted = new Set<ConsensusBucket>(options.buckets ?? ACTIONABLE);

  // Only 'active' rows count. Superseded and excluded rows are filtered here,
  // at the query, so summarizeConsensus has no opinion about why a row was set
  // aside - and rows with no fingerprint (submitted before 0013) are skipped
  // because their outcome was never resolved and cannot be honestly inferred.
  const params: string[] = [];
  const contributions = await client.query<{
    contribution_id: string;
    word_id: string;
    axis: DecisionAxis;
    submitted_by: string;
    submitter_email: string;
    submitted_at: string;
    value_fingerprint: string;
    resolved_value: ContributionOutcome;
  }>(
    `select c.contribution_id, c.word_id, c.axis, c.submitted_by, u.email as submitter_email,
            c.submitted_at, c.value_fingerprint, c.resolved_value
     from contributions c
     join users u on u.user_id = c.submitted_by
     where c.status = 'active'
       and c.word_id is not null
       and c.value_fingerprint is not null
       and c.axis in ('entry', 'etymology')
       ${options.axis ? `and c.axis = $${params.push(options.axis)}` : ''}
       ${options.wordId ? `and c.word_id = $${params.push(options.wordId)}` : ''}
     order by c.submitted_at`,
    params,
  );

  if (contributions.rowCount === 0) return [];

  const wordIds = [...new Set(contributions.rows.map((r) => r.word_id))];

  const [words, decisions] = await Promise.all([
    client.query<{ word_id: string; display_text: string; definition: string | null }>(
      'select word_id, display_text, definition from golden_record where word_id = any($1)',
      [wordIds],
    ),
    client.query<{ word_id: string; axis: DecisionAxis; decided_at: string; value_fingerprint: string | null; email: string }>(
      `select d.word_id, d.axis, d.decided_at, d.value_fingerprint, u.email
       from word_decisions d
       left join users u on u.user_id = d.decided_by
       where d.word_id = any($1)`,
      [wordIds],
    ),
  ]);

  const wordById = new Map(words.rows.map((r) => [r.word_id, r]));
  const decisionByKey = new Map(decisions.rows.map((r) => [`${r.word_id}:${r.axis}`, r]));

  const byKey = new Map<string, ContributionRecord[]>();
  for (const r of contributions.rows) {
    const key = `${r.word_id}:${r.axis}`;
    const record: ContributionRecord = {
      contributionId: r.contribution_id,
      submittedBy: r.submitted_by,
      submitterLabel: r.submitter_email,
      submittedAt: r.submitted_at,
      valueFingerprint: r.value_fingerprint,
      resolvedValue: r.resolved_value,
    };
    const existing = byKey.get(key);
    if (existing) existing.push(record);
    else byKey.set(key, [record]);
  }

  const groups: ConsensusGroup[] = [];
  for (const [key, records] of byKey) {
    const [wordId, axis] = key.split(':') as [string, DecisionAxis];
    const word = wordById.get(wordId);
    if (!word) continue; // word deleted since the contribution was made

    const decision = decisionByKey.get(key);
    const summary = summarizeConsensus(
      records,
      decision ? { fingerprint: decision.value_fingerprint, decidedAt: decision.decided_at } : null,
    );
    if (!wanted.has(summary.bucket)) continue;

    groups.push({
      wordId,
      displayText: word.display_text,
      currentDefinition: word.definition,
      axis,
      decidedAt: decision?.decided_at ?? null,
      decidedByEmail: decision?.email ?? null,
      summary,
    });
  }

  // Conflicts first, then dissent, then the bulk-confirmable set; within a
  // bucket, best-supported first so a curator's attention goes to the clearest
  // wins when bulk-confirming and to the messiest cases when resolving.
  groups.sort(
    (a, b) =>
      BUCKET_PRIORITY[a.summary.bucket] - BUCKET_PRIORITY[b.summary.bucket] ||
      b.summary.totalVotes - a.summary.totalVotes ||
      a.wordId.localeCompare(b.wordId),
  );

  return groups;
}

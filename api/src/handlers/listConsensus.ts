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

/** How one Wiktionary etymology reads to a human.
 *
 * An entry claim carries citedEntryId, which is an opaque upstream token
 * (`en-fa-yo-verb-OFVmd8R8`). Two claims that differ ONLY on which etymology
 * they cite are a genuine disagreement about which word this is - and rendered
 * as bare ids, or not rendered at all, they look identical. */
export interface EtymologyLabel {
  entryId: string;
  form: string;
  /** kaikki_senses.pos is nullable; 'unknown' rather than an empty parenthesis. */
  pos: string;
  etymologyNumber: string | null;
  glosses: string[];
}

/** What the claims on this group refer to, resolved to something readable.
 *
 * Both maps are looked up in batch across every group, not per claim, so this
 * costs two more queries regardless of how many words are in the queue - the
 * same "2 queries, not 2N" shape the rest of this handler follows.
 *
 * Only ids this group's own claims mention appear here, so a client can render
 * a claim from its group alone without carrying a corpus-wide index around. */
export interface ConsensusLabels {
  /** word_id -> display_text, for the components an etymology claim names. */
  components: Record<string, string>;
  /** entry_id -> how it reads, for the etymology an entry claim cites. */
  etymologies: Record<string, EtymologyLabel>;
}

export interface ConsensusGroup {
  wordId: string;
  displayText: string;
  /** golden_record's current definition, as context for judging the claims. */
  currentDefinition: string | null;
  /** golden_record's current spelling and syllables, and the etymology it cites now.
   *
   * The claims are proposals ABOUT this, and a curator choosing between them is
   * choosing against what is on record - which was the one thing the tally never
   * showed. `displayText` above is the same spelling; these are the rest of it. */
  currentSyllables: string[];
  currentCitedEntryId: string | null;
  axis: DecisionAxis;
  /** Present only once a curator has decided. */
  decidedAt: string | null;
  decidedByEmail: string | null;
  summary: ConsensusSummary;
  labels: ConsensusLabels;
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
    // left join, not join: a word with no upstream_citations row (uncited, i.e. created
    // before 0014) still has claims worth tallying, and an inner join would drop it.
    client.query<{
      word_id: string;
      display_text: string;
      definition: string | null;
      syllables: string[];
      cited_entry_id: string | null;
    }>(
      `select g.word_id, g.display_text, g.definition, g.syllables, c.entry_id as cited_entry_id
       from golden_record g
       left join upstream_citations c on c.word_id = g.word_id
       where g.word_id = any($1)`,
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
      currentSyllables: word.syllables ?? [],
      currentCitedEntryId: word.cited_entry_id,
      axis,
      decidedAt: decision?.decided_at ?? null,
      decidedByEmail: decision?.email ?? null,
      summary,
      // Filled in below, once every group is known - the lookups are batched
      // across the whole result rather than run per group.
      labels: { components: {}, etymologies: {} },
    });
  }

  await attachLabels(client, groups);

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

/** Every id any claim in `groups` refers to, resolved once and handed back to the
 * groups that mention it.
 *
 * The ids in an outcome are keys: a component is a word_id, and a cited etymology is
 * an opaque upstream token. Both are the actual substance of what a curator is being
 * asked to choose between, and both were previously either shown raw or not shown at
 * all - so "which spelling is right?" was answered from a vote count and a username.
 *
 * Mutates in place rather than returning a map the caller has to re-attach, which is
 * why groups are pushed with empty labels above: a group is complete by the time it
 * leaves this function, and no caller can forget to join the two halves. */
async function attachLabels(client: Queryable, groups: ConsensusGroup[]): Promise<void> {
  const componentIds = new Set<string>();
  const entryIds = new Set<string>();

  const claimedOutcomes = (g: ConsensusGroup): ContributionOutcome[] => g.summary.tally.map((t) => t.outcome);

  for (const g of groups) {
    // The word's OWN current citation is labelled too, so "what is on record" and "what
    // is being proposed" read the same way rather than one being prose and one an id.
    if (g.currentCitedEntryId) entryIds.add(g.currentCitedEntryId);
    for (const outcome of claimedOutcomes(g)) {
      if (outcome.kind === 'etymology') for (const c of outcome.components) componentIds.add(c);
      else if (outcome.citedEntryId) entryIds.add(outcome.citedEntryId);
    }
  }

  if (componentIds.size === 0 && entryIds.size === 0) return;

  const [components, senses] = await Promise.all([
    componentIds.size > 0
      ? client.query<{ word_id: string; display_text: string }>(
          'select word_id, display_text from golden_record where word_id = any($1)',
          [[...componentIds]],
        )
      : Promise.resolve({ rows: [] as Array<{ word_id: string; display_text: string }> }),
    entryIds.size > 0
      ? client.query<{
          entry_id: string;
          canonical_value: string;
          pos: string | null;
          etymology_number: string | null;
          glosses: string[] | null;
        }>(
          `select entry_id, canonical_value, pos, etymology_number, glosses
           from kaikki_senses where entry_id = any($1)`,
          [[...entryIds]],
        )
      : Promise.resolve({
          rows: [] as Array<{
            entry_id: string;
            canonical_value: string;
            pos: string | null;
            etymology_number: string | null;
            glosses: string[] | null;
          }>,
        }),
  ]);

  const componentById = new Map(components.rows.map((r) => [r.word_id, r.display_text]));
  const senseById = new Map(
    senses.rows.map((r): [string, EtymologyLabel] => [
      r.entry_id,
      {
        entryId: r.entry_id,
        // canonical_value is what upstream calls the word - the same field EtymologyLabel
        // renders as `result.form` on the Add Word screen, so a cited etymology reads
        // identically wherever it appears.
        form: r.canonical_value,
        pos: r.pos ?? 'unknown',
        etymologyNumber: r.etymology_number,
        glosses: r.glosses ?? [],
      },
    ]),
  );

  for (const g of groups) {
    const referenced = (id: string) => {
      const label = componentById.get(id);
      // An id with no row is left OUT rather than mapped to itself. The client falls back
      // to the raw id, and a component naming a word that has since been deleted must not
      // be dressed up as one that resolved.
      if (label !== undefined) g.labels.components[id] = label;
    };
    const cited = (id: string) => {
      const label = senseById.get(id);
      if (label !== undefined) g.labels.etymologies[id] = label;
    };

    if (g.currentCitedEntryId) cited(g.currentCitedEntryId);
    for (const outcome of claimedOutcomes(g)) {
      if (outcome.kind === 'etymology') outcome.components.forEach(referenced);
      else if (outcome.citedEntryId) cited(outcome.citedEntryId);
    }
  }
}

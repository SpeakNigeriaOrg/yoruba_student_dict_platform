// handlers/backfillCitations.ts
//
// A ONE-OFF for the words that predate citations, not a permanent feature.
//
// Every word created from now on cites its etymology at creation
// (createWord.ts), because adding a word IS choosing one. The existing
// vocabulary arrived from a prior data source with only spellings, so its
// identity has to be recovered the hard way - by matching forms back against the
// corpus, which is precisely the lossy operation the citation model exists to
// abolish. That is why this is a backfill and not a design: for `kọ́` there is no
// correct answer to recover, and a human has to say which of the three it was.
//
// planCitationBackfill is READ-ONLY and applyCitationBackfill acts only on what
// the plan resolved, so a dry run shows exactly what a real run will do -
// the same function decides both. Anything a human has to settle is reported,
// never guessed.

import { diagnoseEntry } from '@yoruba-student-dict-platform/shared';
import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';
import { loadVocab } from '../reviewShared.js';
import { writeCitationInTransaction } from './upstreamCitations.js';

export type BackfillOutcome =
  /** One etymology matched unambiguously. Safe to link without a human. */
  | 'auto_link'
  /** A phrase: exempt by nature, its identity comes from its components. */
  | 'exempt_phrase'
  /** A multi-word spelling with no single-word etymology to cite. */
  | 'exempt_multiword'
  /** Genuinely absent from the corpus - the loanwords, calendar names and local
   * compounds. Exempt with a reason that records how we know. */
  | 'exempt_absent'
  /** Several etymologies match one spelling. Nothing can be inferred; this is
   * the `kọ́` case and it needs a person. */
  | 'needs_curator'
  /** Cited already - a word created after E2, or a re-run of this backfill. */
  | 'already_cited';

export interface BackfillPlanItem {
  wordId: string;
  displayText: string;
  outcome: BackfillOutcome;
  /** Set for auto_link only. */
  entryId?: string | null;
  etymologyNumber?: string | null;
  glosses?: string[];
  /** Set for exempt_* only - what gets written as exempt_reason. */
  exemptReason?: string;
  /** Set for needs_curator: what a human has to choose between. */
  candidates?: Array<{ entryId: string | null; etymologyNumber: string | null; pos: string; glosses: string[] }>;
}

export interface BackfillPlan {
  items: BackfillPlanItem[];
  counts: Record<BackfillOutcome, number>;
}

/** Recorded as the reason rather than a bare "not found" so a later reader can
 * tell an evidenced absence from an unexplained blank. */
const ABSENT_REASON = 'no Kaikki etymology for this spelling at backfill time (searched every corpus spelling variant)';
const PHRASE_REASON = 'composed phrase - its identity comes from its components, each of which cites its own etymology';
const MULTIWORD_REASON = 'multi-word entry - no single-word Wiktionary etymology to cite';

export async function planCitationBackfill(client: Queryable): Promise<BackfillPlan> {
  const vocab = await loadVocab(client);
  const lexicon = await loadFullKaikkiLexicon(client);

  const cited = await client.query<{ word_id: string }>('select word_id from upstream_citations');
  const alreadyCited = new Set(cited.rows.map((r) => r.word_id));

  const items: BackfillPlanItem[] = [];
  for (const [wordId, entry] of Object.entries(vocab)) {
    if (alreadyCited.has(wordId)) {
      items.push({ wordId, displayText: entry.displayText, outcome: 'already_cited' });
      continue;
    }

    // Deliberately NO override passed. An override can carry a candidateForm from
    // a pre-citation decision, and resolving that by form takes the FIRST
    // matching etymology - the exact silent substitution this backfill must not
    // launder into a stored citation. Where a human already made a choice we
    // cannot recover, the honest outcome is needs_curator.
    const diagnosis = diagnoseEntry(wordId, entry, lexicon);

    if (diagnosis.status === 'phrase') {
      items.push({ wordId, displayText: entry.displayText, outcome: 'exempt_phrase', exemptReason: PHRASE_REASON });
      continue;
    }
    if (diagnosis.status === 'skipped_multiword') {
      items.push({ wordId, displayText: entry.displayText, outcome: 'exempt_multiword', exemptReason: MULTIWORD_REASON });
      continue;
    }
    if (diagnosis.status === 'not_in_kaikki') {
      items.push({ wordId, displayText: entry.displayText, outcome: 'exempt_absent', exemptReason: ABSENT_REASON });
      continue;
    }
    if (diagnosis.status === 'ambiguous_match' || !diagnosis.matchedEntryId) {
      // Includes the pre-0014-corpus case (matchedEntryId null): a match with no
      // id is not citable, and inventing one would be worse than reporting it.
      items.push({
        wordId,
        displayText: entry.displayText,
        outcome: 'needs_curator',
        candidates: (diagnosis.candidatesConsidered ?? []).map((c) => ({
          entryId: c.entryId ?? null,
          etymologyNumber: c.etymologyNumber ?? null,
          pos: c.pos,
          glosses: c.glosses,
        })),
      });
      continue;
    }

    items.push({
      wordId,
      displayText: entry.displayText,
      outcome: 'auto_link',
      entryId: diagnosis.matchedEntryId,
      etymologyNumber: diagnosis.matchedEtymologyNumber ?? null,
      glosses: diagnosis.matchedGlosses ?? [],
    });
  }

  items.sort((a, b) => a.wordId.localeCompare(b.wordId));

  const counts = {
    auto_link: 0,
    exempt_phrase: 0,
    exempt_multiword: 0,
    exempt_absent: 0,
    needs_curator: 0,
    already_cited: 0,
  } satisfies Record<BackfillOutcome, number>;
  for (const item of items) counts[item.outcome] += 1;

  return { items, counts };
}

export interface BackfillResult {
  applied: number;
  /** Reported rather than silently dropped, so a run that resolves less than the
   * whole vocabulary says so. */
  needsCurator: string[];
  failures: Array<{ wordId: string; error: string }>;
}

/** Writes only what the plan resolved. needs_curator words are left untouched -
 * a citation nobody chose is worse than a missing one, because the missing one is
 * still visible as work outstanding. */
export async function applyCitationBackfill(
  pool: pg.Pool,
  plan: BackfillPlan,
  appliedBy: string | null,
): Promise<BackfillResult> {
  const result: BackfillResult = { applied: 0, needsCurator: [], failures: [] };

  for (const item of plan.items) {
    if (item.outcome === 'already_cited') continue;
    if (item.outcome === 'needs_curator') {
      result.needsCurator.push(item.wordId);
      continue;
    }

    const citation =
      item.outcome === 'auto_link' ? { entryId: item.entryId as string } : { exemptReason: item.exemptReason as string };

    // One transaction per word rather than one for the whole run: a single
    // unexpected word must not roll back 90 correct citations, and each write is
    // independent of the others.
    try {
      await withTransaction(pool, (client) => writeCitationInTransaction(client, item.wordId, citation, appliedBy));
      result.applied += 1;
    } catch (err) {
      result.failures.push({ wordId: item.wordId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

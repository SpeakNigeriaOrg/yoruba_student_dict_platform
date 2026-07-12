// handlers/getEtymologyReview.ts
//
// Backs GET /words/{wordId}/etymology - surfaces both directions of
// Kaikki-suggested etymology data for a curator to reconcile, neither of
// which was surfaced anywhere before this:
//   - componentsProposal: this word's own proposed decomposition (forward -
//     already computed and written to Postgres, but nothing read it into
//     an API response until now).
//   - usedInProposal: kaikki-yoruba's own etymology-driven "which other
//     words use this one as a component" (reverse) - confirmed real and
//     substantial (mọ̀ "to know" has 33 distinct real entries), but never
//     even reached Postgres before this session's ingest/ extension.
// Both are proposals, not facts - applying a curator's decision on either
// (accepting a forward component, or accepting that this word IS a
// component of some other word) already goes through
// applyEtymologyDecision.ts's existing accept_proposed/custom actions
// unchanged; this endpoint only needs to show what there is to reconcile.

import {
  buildComponentOwnersIndex,
  buildVocabSpellingIndex,
  componentsAxisFields,
  diagnoseEntry,
  orthographyInsensitiveForm,
  type ComponentsAxisFieldsResult,
  type DiagnosticsOverrides,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { loadAxisDecided, loadDefinition, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

export interface EtymologyReviewResult extends ComponentsAxisFieldsResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  /** Whether each of the platform's three review axes already has a
   * word_decisions row for this word - shown as read-only context so a
   * curator reviewing etymology (the only axis this screen has an
   * interactive decision UI for) isn't left guessing whether spelling and
   * definition have been separately decided elsewhere. */
  axisDecided: AxisDecided;
  /** Kaikki's free-text etymology prose for this word's matched sense, if
   * any - distinct from componentsProposal (the structured
   * decomposition). A real fraction of entries have only this, no
   * structured template at all - worth surfacing even when nothing could
   * be mechanically decomposed. */
  etymologyText: string | null;
}

/** Only the one field componentsAxisFields actually reads from overrides
 * (targetSpellingConfirmed - whether a resolved target word already has a
 * confirmed spelling decision) - no need to merge all four decision axes
 * into a full DiagnosticsOverrides map for that single check. */
async function loadSpellingConfirmedOverrides(client: Queryable): Promise<DiagnosticsOverrides> {
  const rows = await client.query<{ word_id: string; action: string | null }>(
    `select word_id, decision->>'action' as action from word_decisions
     where axis = 'spelling' and decision->>'action' is not null`,
  );
  const overrides: DiagnosticsOverrides = {};
  for (const row of rows.rows) {
    overrides[row.word_id] = { action: row.action as 'keep_ours' | 'adopt_kaikki' | 'select_candidate' };
  }
  return overrides;
}

export async function getEtymologyReview(client: Queryable, wordId: string): Promise<EtymologyReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const definition = await loadDefinition(client, wordId);
  const axisDecided = await loadAxisDecided(client, wordId);

  const key = orthographyInsensitiveForm(entry.displayText);
  const senses = await loadKaikkiSensesForKey(client, key);
  const lexicon = senses.length > 0 ? { [key]: senses } : {};
  const overrides = await loadSpellingConfirmedOverrides(client);

  const diagnosis = diagnoseEntry(wordId, entry, lexicon);
  const index = buildVocabSpellingIndex(vocab);
  const componentOwners = buildComponentOwnersIndex(vocab);

  const fields = componentsAxisFields(
    wordId,
    vocab,
    diagnosis.matchedComponentCandidates,
    diagnosis.matchedUsedInCandidates,
    lexicon,
    overrides,
    index,
    componentOwners,
  );

  return {
    wordId,
    displayText: entry.displayText,
    syllables: entry.syllables,
    definition,
    axisDecided,
    etymologyText: diagnosis.matchedEtymologyText ?? null,
    ...fields,
  };
}

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
  type Vocab,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { WordNotFoundError } from './errors.js';

export interface EtymologyReviewResult extends ComponentsAxisFieldsResult {
  wordId: string;
  displayText: string;
}

async function loadVocab(client: Queryable): Promise<Vocab> {
  const words = await client.query<{
    word_id: string;
    display_text: string;
    syllables: string[];
    entry_type: 'phrase' | null;
  }>('select word_id, display_text, syllables, entry_type from golden_record');
  const componentRows = await client.query<{ word_id: string; component_word_id: string }>(
    'select word_id, component_word_id from golden_record_components order by word_id, component_position',
  );
  const componentsByWord = new Map<string, string[]>();
  for (const row of componentRows.rows) {
    const existing = componentsByWord.get(row.word_id);
    if (existing) existing.push(row.component_word_id);
    else componentsByWord.set(row.word_id, [row.component_word_id]);
  }

  const vocab: Vocab = {};
  for (const row of words.rows) {
    vocab[row.word_id] = {
      displayText: row.display_text,
      syllables: row.syllables,
      ...(row.entry_type === 'phrase' ? { type: 'phrase' as const } : {}),
      ...(componentsByWord.has(row.word_id) ? { components: componentsByWord.get(row.word_id) } : {}),
    };
  }
  return vocab;
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

  return { wordId, displayText: entry.displayText, ...fields };
}

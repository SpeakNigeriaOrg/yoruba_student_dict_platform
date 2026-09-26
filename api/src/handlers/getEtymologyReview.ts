// handlers/getEtymologyReview.ts
//
// Backs GET /words/{wordId}/etymology - what this word is made of.
//
// ---------------------------------------------------------------------------
// ONE direction, on purpose
// ---------------------------------------------------------------------------
// This used to return the reverse direction too - usedInProposal ("which other words use this
// one") and usedAsComponentOf (the confirmed version of the same). Both are gone, because
// neither was ever actionable HERE: applyEtymologyDecision only ever writes component rows for
// the word under review (see its delete/insert, scoped to `word_id = $1`), so nothing on this
// screen could move an item from usedInProposal into usedAsComponentOf. That transition happens
// when the OTHER word's own etymology axis is decided.
//
// This endpoint's old header claimed otherwise - that "accepting that this word IS a component of
// some other word" went through accept_proposed unchanged. It never did: accept_proposed submits
// componentsProposal only. So the reverse direction was decoration on 47 of 80 cited words, and
// after the request flow landed it became worse than decoration - the shared row component told a
// reader to "add it from the picker below", which would have recorded the inverse relationship.
//
// Derived terms are the example axis's subject, and it teaches them properly ("A phrase built
// from this one: adìyẹ → abo adìyẹ"). They do not belong here.
//
// componentsAxisFields still computes both - it is verified against the Python engine's own
// output and that parity is worth more than deleting two fields from it. They stop at this
// boundary rather than being carried into a response nobody should render.

import {
  buildComponentOwnersIndex,
  buildVocabSpellingIndex,
  componentsAxisFields,
  diagnoseEntry,
  orthographyInsensitiveForm,
  type ComponentsProposalItem,
  type DiagnosticsOverrides,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { loadAxisDecided, loadDefinition, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';
import { loadMyEntryAnswer, type MyEntryAnswer } from '../myEntryAnswer.js';

/** Deliberately NOT `extends ComponentsAxisFieldsResult`: that type carries the reverse-direction
 * fields, and spreading it is how they reached this response in the first place. Listing what the
 * screen actually uses means a field added there cannot silently arrive here. */
/** A proposal item plus the words behind its possibleMatches - the ones we hold under the same
 * letters with different tone marks - so the screen can name them ("we have lá, to be big")
 * instead of gesturing at an unnamed near-miss. Added here rather than in shared's resolver,
 * whose output is pinned field-for-field to the Python engine's by the parity tests. */
export interface ProposalItemWithNearMatches extends ComponentsProposalItem {
  possibleMatchWords: { wordId: string; displayText: string; definition: string | null }[];
}

export interface EtymologyReviewResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  /** 'phrase' for a composed multi-word entry, null for a single word.
   *
   * The screen needs this because the two ask genuinely different questions. A phrase's identity
   * IS its constituent words - that is literally what its citation exemption says - so "does this
   * break into parts?" and "it has no parts" are not available answers about one, and it was being
   * offered both. */
  entryType: 'phrase' | null;
  /** The word as this caller has said it is, when that differs from the record - shown in place
   * of displayText / definition above. See myEntryAnswer.ts. The Kaikki lookup and component
   * proposal still key on the record's spelling: they are about which etymology the word is. */
  myProposedEntry: MyEntryAnswer | null;
  componentsProposal: ProposalItemWithNearMatches[];
  components: string[];
  /** The decomposition WE hold, resolved to spellings, with the atomic self-reference already
   * collapsed to an empty list.
   *
   * `components` above is the raw axis field, which reports an atomic word as `[wordId]` and every
   * component as a bare id. Both are wrong to put in front of a person: the screen was repeating
   * the `[wordId]` test in two places and falling back to printing word_ids when it had no label
   * for one, and this screen's own rule is that a component is shown as the word, not the key.
   *
   * Carries `definition` for the same reason componentsProposal.resolvedDefinition does: a
   * spelling is not a word. `sùn` alone is at least three things (sleep, aim, complain), and this
   * IS what got confirmed as a part - showing only the spelling would tell a reader which word was
   * picked no better than the proposal did before resolvedDefinition existed.
   *
   * Kept as a separate field rather than a change to `components`, whose shape componentsAxisFields
   * owns and other callers read. */
  componentsOnRecord: Array<{ wordId: string; displayText: string; definition: string | null }>;
  /** Whether each of the platform's review axes already has a
   * word_decisions row for this word - shown as read-only context so a
   * curator reviewing etymology (the only axis this screen has an
   * interactive decision UI for) isn't left guessing whether the entry
   * axis has been decided elsewhere. */
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
 * confirmed spelling decision) - no need to merge every decision axis
 * into a full DiagnosticsOverrides map for that single check.
 *
 * Reads the 'entry' axis: since 0011_merge_entry_axis.sql the spelling
 * `action` lives on the merged entry decision alongside the definition
 * fields, so a word's spelling is confirmed exactly when its entry
 * decision carries an action. */
async function loadSpellingConfirmedOverrides(client: Queryable): Promise<DiagnosticsOverrides> {
  const rows = await client.query<{ word_id: string; action: string | null }>(
    `select word_id, decision->>'action' as action from word_decisions
     where axis = 'entry' and decision->>'action' is not null`,
  );
  const overrides: DiagnosticsOverrides = {};
  for (const row of rows.rows) {
    overrides[row.word_id] = { action: row.action as 'keep_ours' | 'adopt_kaikki' | 'select_candidate' };
  }
  return overrides;
}

export async function getEtymologyReview(client: Queryable, wordId: string, userId: string): Promise<EtymologyReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const definition = await loadDefinition(client, wordId);
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const myProposedEntry = await loadMyEntryAnswer(client, wordId, userId);

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
    entryType: entry.type === 'phrase' ? 'phrase' : null,
    axisDecided,
    myProposedEntry,
    etymologyText: diagnosis.matchedEtymologyText ?? null,
    // Named, not spread: see the note on EtymologyReviewResult. usedInProposal and
    // usedAsComponentOf stop here.
    componentsProposal: fields.componentsProposal.map((item) => ({
      ...item,
      possibleMatchWords: item.possibleMatches.map((id) => ({
        wordId: id,
        displayText: vocab[id]?.displayText ?? id,
        definition: vocab[id]?.definition ?? null,
      })),
    })),
    components: fields.components,
    // The self-reference is not a component; see the field's own note. vocab is already loaded, so
    // resolving each id to its spelling costs nothing extra.
    componentsOnRecord:
      fields.components.length === 1 && fields.components[0] === wordId
        ? []
        : fields.components.map((id) => ({
            wordId: id,
            displayText: vocab[id]?.displayText ?? id,
            definition: vocab[id]?.definition ?? null,
          })),
  };
}

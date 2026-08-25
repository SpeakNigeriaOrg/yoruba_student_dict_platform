// handlers/getEntryReview.ts
//
// Backs GET /words/{wordId}/entry - the entry axis: a word's written form
// AND its meaning, reviewed as one unit. Replaces the separate
// getSpellingReview.ts/getDefinitionReview.ts, because the spelling of a
// Yoruba word is not separable from its sense: tone marks and underdots ARE
// semantic, so confirming that a form is correct without knowing which
// gloss is being confirmed isn't a decision about anything.
//
// The two former handlers differed in exactly two ways, and BOTH are
// preserved here rather than averaged:
//
//   1. Lexicon scope. Spelling looked up only this word's own orthography
//      key; definition needed the full corpus, because an explicit
//      definitionSourceForm override can point at ANY Kaikki record (that
//      is the entire point of the manual search-and-redirect). The full
//      corpus is the superset, so it's what's loaded - same accepted
//      small-corpus tradeoff kaikkiSearch.ts already makes.
//
//   2. Whether the stored decision feeds diagnoseEntry. Spelling passed it
//      in, so an already-decided word reports its own resolved status
//      ('verified_keep_ours') instead of re-proposing from scratch.
//      Definition deliberately passed NO override, because the meaning link
//      is independent of which record the spelling axis compares against
//      (resolveDefinitionSource's "MEANING LINK" note). So diagnoseEntry
//      runs TWICE over the one loaded lexicon - cheap, both are pure
//      in-memory calls, and collapsing them to one would silently change
//      which Kaikki record definitions resolve against.

import {
  checkDefinition,
  checkSyllableSplit,
  compareSpellingToPin,
  diagnoseEntry,
  resolveDefinitionSource,
  resolveEffectiveDisplayText,
  type CheckDefinitionResult,
  type CheckSyllableSplitResult,
  type DiagnoseEntryResult,
  type PinSpellingComparison,
  type UpstreamPin,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadFullKaikkiLexicon } from '../kaikkiData.js';
import { loadAxisDecided, loadAxisOverride, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

/** What this word cites, read from upstream_citations - the copy taken when a
 * human validated it, NOT a live Kaikki lookup.
 *
 * That distinction is the whole guarantee: Wiktionary can be edited tomorrow
 * without changing what this screen shows a volunteer today. Drift is surfaced
 * deliberately, by reconciliation, rather than appearing unannounced in the
 * middle of someone's task. */
export interface EntryCitation {
  /** Null when the word is explicitly exempt (no upstream entry exists). */
  entryId: string | null;
  exemptReason: string | null;
  /** The pinned upstream content. Null for an exempt word, which has none. */
  pin: UpstreamPin | null;
}

export interface EntryReviewResult extends DiagnoseEntryResult, CheckSyllableSplitResult, CheckDefinitionResult {
  syllables: string[];
  axisDecided: AxisDecided;
  /** Null for a word with no citation row at all - which after the E3 backfill
   * means only a word created before citations existed. */
  citation: EntryCitation | null;
  /** Our spelling against the pinned upstream one. The single question a
   * volunteer is asked about a cited word's written form; see
   * compareSpellingToPin. */
  spellingVsUpstream: PinSpellingComparison;
  /** The spelling THIS caller last said the word has, if they have an active answer on the
   * entry axis and it differs from the record.
   *
   * Null when they have not answered, or answered with the spelling already on record.
   *
   * It exists for the audio screen. Someone who has just corrected a spelling has said what
   * they think the word IS, and then the recorder offered them the old one to say aloud -
   * which is both the wrong prompt and a recording that publish will drop. Nothing in this
   * result could see it: `displayText` above is golden_record's, and a contribution never
   * reaches golden_record. That was survivable while a curator's answer wrote the record
   * directly; once everyone contributes, it applied to everyone.
   *
   * Read from resolved_value, which is the outcome frozen at submission time (0013) - not
   * re-derived, so it is what they actually asserted rather than what that assertion would
   * mean against a record that has since moved. */
  myProposedEntry: { displayText: string; syllables: string[] } | null;
}

export async function getEntryReview(client: Queryable, wordId: string, userId: string): Promise<EntryReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const citation = await loadCitation(client, wordId);
  const myProposedEntry = await loadMyProposedEntry(client, wordId, userId, entry);
  const override = await loadAxisOverride(client, wordId, 'entry');
  const lexicon = await loadFullKaikkiLexicon(client);

  // --- written form ---
  const diagnosis = diagnoseEntry(wordId, entry, lexicon, override);
  const effective = resolveEffectiveDisplayText(entry, diagnosis, override);
  const syllableSplit = checkSyllableSplit(effective.displayText, entry.syllables, override, effective.wasSubstituted);

  // --- meaning (see note 2 above: no override here, by design) ---
  const freshDiagnosis = diagnoseEntry(wordId, entry, lexicon);
  const source = resolveDefinitionSource(
    freshDiagnosis.matchedForm,
    freshDiagnosis.matchedGlosses,
    freshDiagnosis.matchedAltOfTargets,
    lexicon,
    override,
  );
  const definitionFields = checkDefinition(
    entry,
    freshDiagnosis.englishHint ?? '',
    source.glosses,
    override,
    source.sourceForm,
    source.isCrossReference,
    source.sourceForm === (freshDiagnosis.matchedForm ?? null),
    source.note,
  );

  return {
    ...diagnosis,
    ...syllableSplit,
    ...definitionFields,
    syllables: entry.syllables,
    axisDecided,
    citation,
    // Compared against the EFFECTIVE spelling, so a decision to adopt a new form
    // in this same session is reflected rather than the screen still asking about
    // the superseded one.
    spellingVsUpstream: compareSpellingToPin(effective.displayText, citation?.pin),
    myProposedEntry,
  };
}

/** This caller's own active answer on the entry axis, when it proposes a different spelling
 * from the one on record.
 *
 * Compared NFC-normalised, because a difference of Unicode composition alone is not a
 * proposal - five production words store their text in NFD, and treating those as "you
 * proposed something different" would put a spurious notice in front of every one of them. */
async function loadMyProposedEntry(
  client: Queryable,
  wordId: string,
  userId: string,
  entry: { displayText: string; syllables: string[] },
): Promise<{ displayText: string; syllables: string[] } | null> {
  const { rows } = await client.query<{ resolved_value: { displayText?: string; syllables?: string[] } | null }>(
    `select resolved_value from contributions
      where word_id = $1 and submitted_by = $2 and axis = 'entry' and status = 'active'
      order by submitted_at desc limit 1`,
    [wordId, userId],
  );
  const outcome = rows[0]?.resolved_value;
  if (!outcome?.displayText || !outcome.syllables?.length) return null;

  const same =
    outcome.displayText.normalize('NFC') === entry.displayText.normalize('NFC') &&
    outcome.syllables.length === entry.syllables.length &&
    outcome.syllables.every((s, i) => s.normalize('NFC') === entry.syllables[i].normalize('NFC'));
  return same ? null : { displayText: outcome.displayText, syllables: outcome.syllables };
}

async function loadCitation(client: Queryable, wordId: string): Promise<EntryCitation | null> {
  const { rows } = await client.query<{ entry_id: string | null; exempt_reason: string | null; pin: unknown }>(
    'select entry_id, exempt_reason, pin from upstream_citations where word_id = $1',
    [wordId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    entryId: row.entry_id,
    exemptReason: row.exempt_reason,
    // An exempt row stores {} - there is no upstream content to pin - so it is
    // reported as null rather than as an empty-looking pin the UI would have to
    // second-guess.
    pin: row.entry_id ? (row.pin as UpstreamPin) : null,
  };
}

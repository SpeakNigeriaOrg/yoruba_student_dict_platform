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
import { ENTRY_USAGE_COLUMNS, type EntryUsageRow } from '../entryUsage.js';
import { loadMyEntryAnswer, type MyEntryAnswer } from '../myEntryAnswer.js';
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

/** Part of speech and usage as the record holds them (0029), plus what a reviewer needs to judge
 * them: upstream's own pos, and the words this one survives in. */
export interface EntryUsage {
  /** Resolved: the override, else the pin's - what confirming asserts. */
  pos: string | null;
  /** What the cited Wiktionary etymology files it under, shown beside ours, because upstream is
   * sometimes the one that is wrong (it files jí, "to wake up", as a particle). */
  pinPos: string | null;
  usageLabels: string[];
  onlyInDerivedTerms: boolean;
  /** Words that name this one as a component - the reverse golden_record_components links. Not
   * a complete list of where the word occurs, only the ones this dictionary has linked. */
  derivedTerms: { wordId: string; displayText: string }[];
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
  /** The word as THIS caller has said it is - their active entry answer, when it differs from the
   * record. Null when they have not answered, or answered with what is on record.
   *
   * Every screen that shows this caller the word shows this in place of the record, with a
   * marker - see myEntryAnswer.ts for why. */
  myProposedEntry: MyEntryAnswer | null;
  usage: EntryUsage;
}

export async function getEntryReview(client: Queryable, wordId: string, userId: string): Promise<EntryReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const citation = await loadCitation(client, wordId);
  const myProposedEntry = await loadMyEntryAnswer(client, wordId, userId);
  const usage = await loadEntryUsage(client, wordId);
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
    usage,
  };
}

export async function loadEntryUsage(client: Queryable, wordId: string): Promise<EntryUsage> {
  const own = await client.query<EntryUsageRow & { pin_pos: string | null }>(
    `select ${ENTRY_USAGE_COLUMNS}, c.pin ->> 'pos' as pin_pos
     from golden_record g
     left join upstream_citations c on c.word_id = g.word_id
     where g.word_id = $1`,
    [wordId],
  );
  const row = own.rows[0];
  if (!row) throw new WordNotFoundError(wordId);
  const derived = await client.query<{ word_id: string; display_text: string }>(
    `select distinct g.word_id, g.display_text
     from golden_record_components gc
     join golden_record g on g.word_id = gc.word_id
     where gc.component_word_id = $1 and gc.word_id <> $1
     order by g.display_text`,
    [wordId],
  );
  return {
    pos: row.resolved_pos,
    pinPos: row.pin_pos,
    usageLabels: row.usage_labels,
    onlyInDerivedTerms: row.only_in_derived_terms,
    derivedTerms: derived.rows.map((r) => ({ wordId: r.word_id, displayText: r.display_text })),
  };
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

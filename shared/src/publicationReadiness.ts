// publicationReadiness.ts
//
// What stops a word from shipping — stated once, for every consumer.
//
// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
// Two different audiences ask the same question and used to get it from different code.
// The publish and export scripts ask it to decide what to drop; the curation app asks it
// to tell a curator what to fix. When those two disagree, the app tells someone their
// dictionary is ready and the export quietly omits half of it — which is the exact class
// of failure this repo has already had once, when the audio axis read green while
// publishToR2 was excluding every recording behind it.
//
// So the rules live here, in shared/, which both sides can reach: api/ imports the built
// package, and the scripts import ../shared/dist/index.js directly (several already do).
//
// ---------------------------------------------------------------------------
// Codes, and prose, kept apart
// ---------------------------------------------------------------------------
// The scripts print sentences; the curator survey needs something filterable and
// countable. So each rule yields a CODE, and describe* turns a code into the sentence the
// scripts have always printed. One rule, two renderings, no second copy of the rule.

/** The SQL predicate for "this recording still describes the word as it now stands".
 *
 * A string rather than a shared query because the five callers select wildly different
 * things around it — a coverage count, a per-user boolean, three different exports. What
 * they must not differ on is the comparison, and this is it.
 *
 * Byte-exact and deliberately NOT Unicode-normalising: the aim is to agree with what
 * publish actually does. A more lenient version here would put back the gap where the app
 * says a word is recorded and the export drops it.
 *
 * `u` and `g` name the utterances and golden_record aliases at the call site, because the
 * scripts call theirs `w`.
 */
export function recordingMatchesGoldenSql(utterances = 'u', golden = 'g'): string {
  return `${utterances}.recorded_display_text = ${golden}.display_text and ${utterances}.recorded_syllables = ${golden}.syllables`;
}

/** The same comparison in TypeScript, for callers holding rows rather than querying. */
export function recordingMatchesGolden(
  recordedDisplayText: string,
  recordedSyllables: string[],
  golden: { display_text: string; syllables: string[] },
): boolean {
  return (
    recordedDisplayText === golden.display_text &&
    recordedSyllables.length === golden.syllables.length &&
    recordedSyllables.every((s, i) => s === golden.syllables[i])
  );
}

// ---------------------------------------------------------------------------
// Shipping to the game
// ---------------------------------------------------------------------------

/** Why the game export would skip this word.
 *
 * Ordered by how fixable each one is. `no_image` is a HARD gate rather than a degrade -
 * a word presented with a placeholder standing in for its picture is fabricated content,
 * which is worse than the word being absent. */
export type GameBlocker =
  /** No take-1 recording by any speaker that still matches the word. */
  | 'no_matching_recording'
  /** A recording exists, but was made under a spelling or split the word no longer has. */
  | 'only_stale_recordings'
  /** No speaker has recorded every one of this word's syllables. */
  | 'no_speaker_covers_syllables'
  /** No image at all. */
  | 'no_image';

export function describeGameBlocker(blocker: GameBlocker): string {
  switch (blocker) {
    case 'no_matching_recording':
      return 'nobody has recorded this word yet';
    case 'only_stale_recordings':
      return 'every recording of it was made under a spelling the word no longer has - it needs re-recording';
    case 'no_speaker_covers_syllables':
      return 'no single speaker has recorded all of its syllables, so no level can use it';
    case 'no_image':
      return 'no image, and a word is never shown with a placeholder standing in for one';
  }
}

export interface GameReadinessInput {
  /** Speakers with a take-1 recording that still matches the word. */
  matchingSpeakerCount: number;
  /** Speakers whose recordings exist but no longer match. */
  divergedSpeakerCount: number;
  /** Speakers who have recorded every one of this word's current syllables. */
  fullyCoveredSpeakerCount: number;
  imageCount: number;
}

export function gameBlockers(input: GameReadinessInput): GameBlocker[] {
  const blockers: GameBlocker[] = [];
  if (input.matchingSpeakerCount === 0) {
    // Told apart deliberately. "Nobody recorded it" is work to schedule; "the recordings
    // stopped counting" is work already done that a later respelling invalidated, and the
    // person who can fix it is the one who recorded it.
    blockers.push(input.divergedSpeakerCount > 0 ? 'only_stale_recordings' : 'no_matching_recording');
  } else if (input.fullyCoveredSpeakerCount === 0) {
    blockers.push('no_speaker_covers_syllables');
  }
  if (input.imageCount === 0) blockers.push('no_image');
  return blockers;
}

// ---------------------------------------------------------------------------
// Contributing back to Wiktionary
// ---------------------------------------------------------------------------

/** Why this entry cannot be drafted for Wiktionary.
 *
 * These three are the hard ones - scripts/exportWiktionaryDrafts.mjs refuses to emit a
 * draft without them. Everything else that script reports is a note, not a blocker. */
export type WiktionaryBlocker = 'no_citation_row' | 'no_part_of_speech' | 'no_english_gloss';

export function describeWiktionaryBlocker(blocker: WiktionaryBlocker): string {
  switch (blocker) {
    case 'no_citation_row':
      return 'no citation row: cannot tell whether Wiktionary already has this entry';
    case 'no_part_of_speech':
      return 'no part of speech (set golden_record.pos)';
    case 'no_english_gloss':
      return 'no English gloss (set golden_record.english_gloss)';
  }
}

export interface WiktionaryReadinessInput {
  /** Whether an upstream_citations row names an entry_id. */
  cited: boolean;
  exemptReason: string | null;
  /** golden_record.pos, or the pin's, whichever the caller resolved. */
  pos: string | null;
  /** golden_record.english_gloss as a list, or the pin's glosses. */
  glosses: string[];
}

export function wiktionaryBlockers(input: WiktionaryReadinessInput): WiktionaryBlocker[] {
  const blockers: WiktionaryBlocker[] = [];
  // 0014 backfilled nothing by design, so an uncited word predates citations rather than
  // being at fault - but nothing can tell whether upstream already has it, which is the
  // first thing anyone contributing must know.
  if (!input.cited && !input.exemptReason) blockers.push('no_citation_row');
  if (!input.pos) blockers.push('no_part_of_speech');
  if (input.glosses.length === 0) blockers.push('no_english_gloss');
  return blockers;
}

// ---------------------------------------------------------------------------
// How a word relates to upstream at all
// ---------------------------------------------------------------------------

/** Three populations, and conflating them is how the uncited ones stayed invisible.
 *
 * `exempt` is a decision on record: someone established there is no Wiktionary entry and
 * said why. `uncited` is the absence of any decision. The drift report has always counted
 * `uncited` and never named the words, which is the same defect `exemptItems` was added to
 * fix for the other population. */
export type CitationState = 'cited' | 'exempt' | 'uncited';

export function citationState(entryId: string | null, exemptReason: string | null): CitationState {
  if (entryId) return 'cited';
  if (exemptReason) return 'exempt';
  return 'uncited';
}

// consensus.ts
//
// Turns a set of volunteer contributions on one (word, axis) into a single
// synthesized view: what the population actually claims, whether it agrees,
// and whether it contradicts a curator's existing golden decision.
//
// This exists because a contribution is EVIDENCE, not a proposal addressed to
// a curator. The old model applied one volunteer's proposed_value verbatim on
// approval, which made the curator's question "is this person right?" instead
// of "what is true?".
//
// ---------------------------------------------------------------------------
// Why outcomes, not actions
// ---------------------------------------------------------------------------
// Agreement CANNOT be computed by comparing the action-shaped input. The same
// claim has several spellings: `keep_ours` and `select_candidate` naming the
// form the word already has are identical assertions about content. Both of
// the two real spelling decisions in production are `select_candidate`, so
// comparing actions would score identical claims as disagreement.
//
// So a contribution is reduced to its OUTCOME - the content state it asserts -
// and outcomes are compared.
//
// ---------------------------------------------------------------------------
// Why the outcome must be frozen at submission time
// ---------------------------------------------------------------------------
// `keep_ours` means "whatever the record says now". Resolving it later, against
// a record that has since changed, would retroactively put words in a
// volunteer's mouth - it would silently reinterpret their belief under a
// spelling they never asserted.
//
// This is not a new principle. 0006_utterance_pronunciation.sql froze
// recorded_display_text/recorded_syllables on every recording for exactly this
// reason ("a recording's syllable identity is never silently reinterpreted
// under a pronunciation the speaker never actually said"), and
// syllable_observations freezes three orthographic forms at insert rather than
// recomputing them. resolveEntryOutcome is that same discipline applied to
// text contributions: callers resolve ONCE, at submit time, against the state
// the contributor actually saw, and store the result.

import { syllabifyWord } from './syllabify.js';

/** How many agreeing contributions make a (word, axis) eligible for rapid
 * bulk confirmation. One constant, read by both the API and the UI, so the
 * bar can be raised as the volunteer pool grows without hunting through
 * handlers. */
export const AGREEMENT_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Entry axis
// ---------------------------------------------------------------------------

/** The content state a contributor saw when they made their decision. Passed
 * in explicitly rather than read from a lexicon so this stays pure. */
export interface EntryObservedState {
  displayText: string;
  syllables: string[];
  definition: string | null;
}

/** The action-shaped submission. Mirrors ApplyEntryDecisionInput's content
 * fields; note/definitionSourceForm are deliberately absent - see the note on
 * EntryOutcome. */
export interface EntryContributionInput {
  action?: 'keep_ours' | 'select_candidate' | 'adopt_kaikki';
  candidateForm?: string;
  newDisplayText?: string;
  syllableAction?: 'keep_manual' | 'accept_programmatic';
  definitionAction?: 'confirm' | 'custom';
  definitionText?: string;
}

/** The asserted content state.
 *
 * Deliberately excludes `candidateForm` and `definitionSourceForm`. Those
 * record WHICH Kaikki record a contributor consulted - provenance, not the
 * claim. Two volunteers who reach the same spelling and the same definition
 * text by different routes are making the same assertion about the word, and
 * should count as agreeing. `note` is excluded for the same reason. */
export interface EntryOutcome {
  kind: 'entry';
  displayText: string;
  syllables: string[];
  definitionText: string | null;
}

/** Resolves an entry submission into the content state it asserts.
 *
 * Mirrors applyEntryDecision's write rules exactly - if that handler's
 * behaviour changes, this must change with it, or a contribution's recorded
 * outcome would stop describing what applying it actually does:
 *
 *   - display_text changes ONLY on adopt_kaikki. keep_ours and
 *     select_candidate deliberately leave it alone; select_candidate resolves
 *     which Kaikki SENSE this word matches, it is not a rename.
 *   - syllables are recomputed only on accept_programmatic, and from the
 *     spelling the word is BECOMING (post-adoption), not the one on record.
 *   - the definition is replaced only by 'custom'; 'confirm' blesses the text
 *     already present.
 */
export function resolveEntryOutcome(observed: EntryObservedState, input: EntryContributionInput): EntryOutcome {
  const displayText =
    input.action === 'adopt_kaikki' && input.newDisplayText ? input.newDisplayText : observed.displayText;

  const syllables = input.syllableAction === 'accept_programmatic' ? syllabifyWord(displayText) : observed.syllables;

  const definitionText =
    input.definitionAction === 'custom' ? (input.definitionText ?? null) : observed.definition;

  return { kind: 'entry', displayText, syllables, definitionText };
}

// ---------------------------------------------------------------------------
// Etymology axis
// ---------------------------------------------------------------------------

export type ComponentsAction = 'confirm_atomic' | 'confirm_existing' | 'reject_proposed' | 'accept_proposed' | 'custom';

export interface EtymologyObservedState {
  components: string[];
}

export interface EtymologyContributionInput {
  componentsAction: ComponentsAction;
  components?: string[];
}

/** `atomic` carries the one claim that isn't visible in the resulting content:
 * confirm_atomic asserts "this word has no parts", which on a word that
 * already has none produces the same component list as confirm_existing while
 * meaning something different. Kept separate so those two don't silently
 * fingerprint as agreement.
 *
 * confirm_existing and reject_proposed DO collapse together, correctly - both
 * assert "the components currently on record are the right ones". */
export interface EtymologyOutcome {
  kind: 'etymology';
  components: string[];
  atomic: boolean;
}

/** Mirrors applyEtymologyDecision: only accept_proposed and custom replace the
 * component list; the other three leave whatever is on record untouched and
 * merely record that a review happened. */
export function resolveEtymologyOutcome(
  observed: EtymologyObservedState,
  input: EtymologyContributionInput,
): EtymologyOutcome {
  const replaces = input.componentsAction === 'accept_proposed' || input.componentsAction === 'custom';
  return {
    kind: 'etymology',
    components: replaces ? (input.components ?? []) : observed.components,
    atomic: input.componentsAction === 'confirm_atomic',
  };
}

export type ContributionOutcome = EntryOutcome | EtymologyOutcome;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/** A separator that cannot occur in Yoruba text or an English gloss, so field
 * boundaries in the fingerprint are unambiguous - joining with a printable
 * character would let "a|b" + "c" collide with "a" + "b|c". Written as
 * escapes rather than literal control bytes so an editor, formatter, or
 * copy-paste can't silently eat them. */
const FIELD_SEP = '\u001f';
const LIST_SEP = '\u001e';

/** Distinct from the empty string, so "no definition at all" never collides
 * with "a definition that normalized to empty".
 *
 * Group separator (GS), NOT NUL. It was \u0000 first, which Postgres rejects
 * outright - `text` forbids 0x00 - so every entry with no definition produced a
 * fingerprint that could not be stored. Any control character except NUL is
 * storable and unreachable from a text input. */
const NULL_MARKER = '\u001d';

/** Unicode NFC + whitespace normalization, applied to every field.
 *
 * NFC matters here specifically: Yoruba text carries combining tone marks and
 * underdots, so the same visible form can arrive as precomposed or decomposed
 * codepoints depending on the contributor's keyboard or OS. Without NFC two
 * people who typed the identical word would fingerprint differently. */
function normalizeText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Definition text only.
 *
 * Case is folded because definitions are English glosses and "Giraffe" is not
 * a different claim from "giraffe".
 *
 * Case is NOT folded on displayText or syllables. Yoruba orthography is
 * case-bearing in a way that matters - `Agẹmọ` is a month name, and folding
 * would merge proper nouns with common ones. Diacritics and underdots are
 * never folded anywhere: they ARE the semantic content, which is the whole
 * premise of the entry axis. */
function normalizeDefinition(value: string): string {
  return normalizeText(value).toLowerCase();
}

/** The comparison key for an outcome. Equal fingerprints mean two
 * contributors asserted the same thing. */
export function fingerprintOutcome(outcome: ContributionOutcome): string {
  if (outcome.kind === 'entry') {
    return [
      'entry',
      normalizeText(outcome.displayText),
      outcome.syllables.map(normalizeText).join(LIST_SEP),
      outcome.definitionText === null ? NULL_MARKER : normalizeDefinition(outcome.definitionText),
    ].join(FIELD_SEP);
  }
  return [
    'etymology',
    outcome.atomic ? 'atomic' : 'composite',
    outcome.components.map(normalizeText).join(LIST_SEP),
  ].join(FIELD_SEP);
}

// ---------------------------------------------------------------------------
// Tallying
// ---------------------------------------------------------------------------

/** One contribution as the tally needs it. Mirrors the stored columns, so
 * callers pass rows through without reshaping. */
export interface ContributionRecord {
  contributionId: string;
  submittedBy: string;
  /** Display name or email, for attribution in the curator UI. */
  submitterLabel?: string | null;
  submittedAt: string | Date;
  valueFingerprint: string;
  resolvedValue: ContributionOutcome;
}

/** The existing curator decision, when there is one. `fingerprint` may be null
 * for decisions recorded before fingerprints existed - dissent can't be
 * computed against those, and they're reported as plain 'golden'. */
export interface GoldenReference {
  fingerprint: string | null;
  decidedAt: string | Date;
}

export interface ConsensusTallyEntry {
  fingerprint: string;
  outcome: ContributionOutcome;
  count: number;
  voters: string[];
  voterLabels: string[];
  earliestSubmittedAt: string;
}

export type ConsensusBucket =
  /** No contributions and no decision - nobody has looked at this yet. */
  | 'none'
  /** Exactly one distinct claim, below the agreement threshold. */
  | 'single'
  /** One distinct claim at or above the threshold - the bulk-confirm queue. */
  | 'ready'
  /** More than one distinct claim. Needs a human, and jumps the queue. */
  | 'contested'
  /** A curator has decided, and a LATER contribution disagrees. */
  | 'dissent_on_golden'
  /** A curator has decided and nothing since has contradicted it. */
  | 'golden';

export interface ConsensusSummary {
  /** Distinct claims, most-supported first; ties broken by who claimed it
   * first, so the ordering is stable across calls. */
  tally: ConsensusTallyEntry[];
  /** The most-supported claim, or null when the top two are tied - a tie has
   * no winner to offer for one-click confirmation. */
  winner: ConsensusTallyEntry | null;
  totalVotes: number;
  /** Votes behind `winner`, or 0 when tied. */
  agreementCount: number;
  isContested: boolean;
  isTied: boolean;
  meetsThreshold: boolean;
  /** Claims submitted AFTER the golden decision that contradict it.
   *
   * Deliberately post-decision only: a contribution the curator already saw
   * and overruled is not dissent, and counting it would leave every overruled
   * word flagged forever.
   *
   * "After" is resolved at MILLISECOND granularity, because that is all a JS
   * Date preserves of a Postgres timestamptz. Two events in the same
   * millisecond therefore count as simultaneous, i.e. not after - which in
   * production means a curator decision and a contribution would have to land
   * inside the same millisecond to be missed. Tests that need the distinction
   * must space the timestamps explicitly rather than relying on execution
   * order. */
  dissentsFromGolden: ConsensusTallyEntry[];
  bucket: ConsensusBucket;
}

function toMillis(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Synthesizes one (word, axis)'s contributions into a single view.
 *
 * Callers pass only the contributions that should count - superseded and
 * excluded rows are filtered out at the query, not here, so this function has
 * no opinion about why a row was set aside. */
export function summarizeConsensus(
  contributions: ContributionRecord[],
  golden?: GoldenReference | null,
): ConsensusSummary {
  const groups = new Map<string, ConsensusTallyEntry>();
  for (const c of contributions) {
    const existing = groups.get(c.valueFingerprint);
    if (existing) {
      existing.count += 1;
      existing.voters.push(c.submittedBy);
      if (c.submitterLabel) existing.voterLabels.push(c.submitterLabel);
      if (toMillis(c.submittedAt) < toMillis(existing.earliestSubmittedAt)) {
        existing.earliestSubmittedAt = toIso(c.submittedAt);
      }
    } else {
      groups.set(c.valueFingerprint, {
        fingerprint: c.valueFingerprint,
        outcome: c.resolvedValue,
        count: 1,
        voters: [c.submittedBy],
        voterLabels: c.submitterLabel ? [c.submitterLabel] : [],
        earliestSubmittedAt: toIso(c.submittedAt),
      });
    }
  }

  const tally = [...groups.values()].sort(
    (a, b) => b.count - a.count || toMillis(a.earliestSubmittedAt) - toMillis(b.earliestSubmittedAt),
  );

  const isTied = tally.length > 1 && tally[0].count === tally[1].count;
  const winner = tally.length > 0 && !isTied ? tally[0] : null;
  const totalVotes = contributions.length;
  const agreementCount = winner?.count ?? 0;
  const isContested = tally.length > 1;
  const meetsThreshold = agreementCount >= AGREEMENT_THRESHOLD;

  const dissentsFromGolden: ConsensusTallyEntry[] = [];
  if (golden && golden.fingerprint !== null) {
    const decidedAtMs = toMillis(golden.decidedAt);
    for (const entry of tally) {
      if (entry.fingerprint === golden.fingerprint) continue;
      // Re-derive per-claim latest submission: an entry dissents only if at
      // least one of its supporters spoke after the decision.
      const spokeAfter = contributions.some(
        (c) => c.valueFingerprint === entry.fingerprint && toMillis(c.submittedAt) > decidedAtMs,
      );
      if (spokeAfter) dissentsFromGolden.push(entry);
    }
  }

  let bucket: ConsensusBucket;
  if (golden) {
    bucket = dissentsFromGolden.length > 0 ? 'dissent_on_golden' : 'golden';
  } else if (tally.length === 0) {
    bucket = 'none';
  } else if (isContested) {
    // Disagreement outranks a comfortable majority: 3-vs-1 still means one
    // person saw something the others didn't, and that is worth a look.
    // `winner`/`meetsThreshold` stay populated so the UI can still offer
    // "confirm the majority" without a second pass.
    bucket = 'contested';
  } else {
    bucket = meetsThreshold ? 'ready' : 'single';
  }

  return {
    tally,
    winner,
    totalVotes,
    agreementCount,
    isContested,
    isTied,
    meetsThreshold,
    dissentsFromGolden,
    bucket,
  };
}

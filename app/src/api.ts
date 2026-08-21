// api.ts
//
// Thin fetch wrapper over api/'s endpoints - not a generated client, just
// the handful this app actually calls. Relative /api/* paths match SWA's
// own routing convention (same origin once deployed, no CORS config
// needed). Response shapes mirror api/'s own handler return types exactly
// (api/'s handlers aren't published as an importable package the way
// shared/ is, so these are hand-kept in sync, same as identity.ts already
// does for ClientPrincipal).

import type {
  CheckDefinitionResult,
  CheckSyllableSplitResult,
  ComponentsProposalItem,
  ConsensusBucket,
  ConsensusSummary,
  DiagnoseEntryResult,
  KaikkiSearchResult,
  PinSpellingComparison,
  UpstreamPin,
  VocabSearchResult,
} from '@yoruba-student-dict-platform/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, (body as { error?: string }).error ?? `${url} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// Mirrors api/src/handlers/listMyAssignments.ts's AssignmentSummary.
export interface AssignmentSummary {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  assignedAt: string;
  axisDecided: AxisDecided;
}

export function getMyAssignments(): Promise<AssignmentSummary[]> {
  return fetchJson('/api/assignments/me');
}

// Mirrors api/src/handlers/listUsers.ts's UserSummary.
export interface UserSummary {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
  assignedWordCount: number;
  inReviewCount: number;
  passedCount: number;
}

export function getUsers(): Promise<UserSummary[]> {
  return fetchJson<{ users: UserSummary[] }>('/api/users').then((r) => r.users);
}

// Mirrors api/src/handlers/createUser.ts's CreateUserInput/CreatedUser -
// registers a user account by Google email ahead of their first login. This is
// the access gate: an unregistered address can authenticate with Google and
// still be granted no roles, so it can reach nothing.
//
// The old caveat here (that a 'curator' role also needed an Azure Static Web
// Apps portal invite to survive first login) is gone - the SWA is on Standard
// and the roles-source function reads users.role.
export interface CreateUserInput {
  email: string;
  displayName?: string | null;
  role: 'curator' | 'volunteer';
}

export interface CreatedUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
}

export function createUser(input: CreateUserInput): Promise<CreatedUser> {
  return fetchJson('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// Mirrors api/src/handlers/updateUserRole.ts. Role management lives here now
// rather than in the Azure Portal - that only became possible on the Standard
// plan, where a roles-source function can read users.role.
//
// Takes effect on the user's NEXT LOGIN, because SWA caches roles into the
// session token; server-side curator checks re-read the database immediately.
export function updateUserRole(userId: string, role: 'curator' | 'volunteer'): Promise<CreatedUser> {
  return fetchJson(`/api/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}

// Mirrors api/src/reviewShared.ts's ReviewStatus - per-axis
// not_started/in_review/passed, independent of AxisDecided (which is
// boolean-only and global-per-decided-axis).
export interface ReviewStatus {
  entry: 'not_started' | 'in_review' | 'passed';
  etymology: 'not_started' | 'in_review' | 'passed';
}

// Mirrors api/src/handlers/listUserAssignments.ts's UserAssignmentSummary.
export interface UserAssignmentSummary {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  assignedAt: string;
  assignedByEmail: string | null;
  axisDecided: AxisDecided;
  reviewStatus: ReviewStatus;
}

export function getUserAssignments(userId: string): Promise<UserAssignmentSummary[]> {
  return fetchJson<{ assignments: UserAssignmentSummary[] }>(`/api/assignments/${encodeURIComponent(userId)}`).then(
    (r) => r.assignments,
  );
}

// Mirrors api/src/handlers/createAssignments.ts's CreateAssignmentsResult.
export interface CreateAssignmentsResult {
  created: string[];
  alreadyAssigned: string[];
}

export function assignWords(userId: string, wordIds: string[]): Promise<CreateAssignmentsResult> {
  return fetchJson('/api/assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, wordIds }),
  });
}

// Mirrors api/src/handlers/createAssignments.ts's AssignmentScope: the
// server resolves the word list so it can't go stale between the curator
// loading a list and pressing the button.
export type AssignmentScope = 'all' | 'incomplete';

export function assignWordsByScope(userId: string, scope: AssignmentScope): Promise<CreateAssignmentsResult> {
  return fetchJson('/api/assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, scope }),
  });
}

export function unassignWord(userId: string, wordId: string): Promise<{ userId: string; wordId: string; status: string }> {
  return fetchJson(`/api/assignments/${encodeURIComponent(userId)}/${encodeURIComponent(wordId)}`, {
    method: 'DELETE',
  });
}

// Mirrors api/src/reviewShared.ts's AxisDecided - whether each of the two
// decision-driven review axes already has a word_decisions row, plus
// whether audio has at least one registered recording - shown as
// read-only context on every review screen.
//
// 'entry' covers a word's written form AND its meaning together; they were
// separate 'spelling'/'definition' axes until db/migrations/
// 0011_merge_entry_axis.sql merged them.
export interface AxisDecided {
  entry: boolean;
  etymology: boolean;
  audio: boolean;
  /** Whether THIS user has contributed an example of the word in use. Per-user like
   * audio: several different examples are more material, not a conflict, so someone
   * else's example must not read as done. */
  example: boolean;
}

// Mirrors api/src/handlers/getAxisStatus.ts - a lightweight fetch of just
// this shape, for coloring the axis-tab bar without waiting on whichever
// single (heavier) review screen happens to be showing.
export function getAxisStatus(wordId: string): Promise<AxisDecided> {
  return fetchJson(`/api/words/${encodeURIComponent(wordId)}/axis-status`);
}

// Mirrors api/src/handlers/getEtymologyReview.ts's EtymologyReviewResult.
//
// Listed field by field rather than extending ComponentsAxisFieldsResult, which is how the
// reverse-direction fields (usedInProposal, usedAsComponentOf) reached this screen in the first
// place. The server no longer sends them - see that handler for why they were never actionable here.
export interface EtymologyReviewResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  /** 'phrase' for a composed multi-word entry. A phrase's identity IS its constituent words, so it
   * is asked which words it is made of rather than whether it has parts. */
  entryType: 'phrase' | null;
  componentsProposal: ComponentsProposalItem[];
  components: string[];
  /** Our own decomposition, resolved to spellings, atomic collapsed to []. See the handler: this
   * exists so the screen shows words rather than word_ids, and tests "do we hold a breakdown?"
   * in one place instead of repeating the `[wordId]` self-reference check. */
  componentsOnRecord: Array<{ wordId: string; displayText: string }>;
  axisDecided: AxisDecided;
  // Wiktionary's free-text etymology prose, distinct from componentsProposal
  // (the structured decomposition) - present even for entries with no
  // structured breakdown at all.
  etymologyText: string | null;
}

export function getEtymologyReview(wordId: string): Promise<EtymologyReviewResult> {
  return fetchJson(`/api/words/${encodeURIComponent(wordId)}/etymology`);
}

// Mirrors api/src/handlers/applyEtymologyDecision.ts's ApplyEtymologyDecisionInput.
export type ComponentsAction = 'confirm_atomic' | 'confirm_existing' | 'reject_proposed' | 'accept_proposed' | 'custom';

export interface ApplyEtymologyDecisionInput {
  componentsAction: ComponentsAction;
  components?: string[];
  note?: string;
}

export function postEtymologyDecision(wordId: string, input: ApplyEtymologyDecisionInput): Promise<void> {
  return fetchJson(`/api/decisions/etymology`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wordId, ...input }),
  });
}

// Mirrors api/src/handlers/getEntryReview.ts's EntryReviewResult - the
// written-form fields (DiagnoseEntryResult + CheckSyllableSplitResult) and
// the meaning fields (CheckDefinitionResult) arrive in ONE response, because
// they are reviewed as one task.
export interface EntryReviewResult extends DiagnoseEntryResult, CheckSyllableSplitResult, CheckDefinitionResult {
  syllables: string[];
  axisDecided: AxisDecided;
  /** What this word cites, and the COPY of that etymology taken when a human
   * validated it. The screen renders from this pin rather than from a live Kaikki
   * lookup, so Wiktionary changing cannot alter a task mid-flight. Null only for
   * a word created before citations existed. */
  citation: {
    entryId: string | null;
    exemptReason: string | null;
    pin: UpstreamPin | null;
  } | null;
  /** Our spelling against the pinned upstream one - the single question a
   * volunteer is asked about a cited word's written form. */
  spellingVsUpstream: PinSpellingComparison;
}

export function getEntryReview(wordId: string): Promise<EntryReviewResult> {
  return fetchJson(`/api/words/${encodeURIComponent(wordId)}/entry`);
}

// Mirrors api/src/handlers/applyEntryDecision.ts's ApplyEntryDecisionInput.
// The server REQUIRES both `action` and `definitionAction` - an entry
// decision covers spelling and meaning together or not at all. They are
// optional here only so the screen can hold a partly-filled draft before the
// user commits it.
export interface ApplyEntryDecisionInput {
  action?: 'keep_ours' | 'select_candidate' | 'adopt_kaikki' | 'respell';
  candidateForm?: string;
  newDisplayText?: string;
  /** Required with 'respell': the syllables as the reviewer edited them. Authored,
   * not re-derived - re-syllabifying would discard the boundaries they chose, and for
   * a syllabic nasal that changes the word. */
  newSyllables?: string[];
  syllableAction?: 'keep_manual' | 'accept_programmatic';
  syllableNote?: string;
  definitionAction?: 'confirm' | 'custom';
  definitionText?: string;
  definitionSourceForm?: string;
  /** The etymology this decision says the word IS - set when a different one was
   * picked from the candidates or via search. Unlike candidateForm (a spelling,
   * which identifies nothing when several etymologies share it), this is what
   * actually gets cited. */
  senseEntryId?: string;
  note?: string;
}

export function postEntryDecision(wordId: string, input: ApplyEntryDecisionInput): Promise<void> {
  return fetchJson(`/api/decisions/entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wordId, ...input }),
  });
}

// Mirrors api/src/functions/kaikkiSearch.ts / api/src/functions/vocabSearch.ts.
export function searchKaikki(query: string): Promise<KaikkiSearchResult[]> {
  return fetchJson<{ results: KaikkiSearchResult[] }>(`/api/kaikki-search?q=${encodeURIComponent(query)}`).then(
    (r) => r.results,
  );
}

export function searchVocab(query: string): Promise<VocabSearchResult[]> {
  return fetchJson<{ results: VocabSearchResult[] }>(`/api/vocab-search?q=${encodeURIComponent(query)}`).then(
    (r) => r.results,
  );
}

// Mirrors api/src/handlers/listAllWords.ts's AllWordsListItem.
export interface AllWordsListItem {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  axisDecided: AxisDecided;
}

export function getAllWords(): Promise<AllWordsListItem[]> {
  return fetchJson<{ words: AllWordsListItem[] }>('/api/words').then((r) => r.words);
}

// Mirrors api/src/handlers/checkDuplicates.ts's DuplicateMatch (from shared/).
export interface DuplicateMatch {
  wordId: string;
  displayText: string;
  reason: string;
}

export function getDuplicateCheck(spelling: string, altOfTargets: string[]): Promise<DuplicateMatch[]> {
  const params = new URLSearchParams({ spelling });
  if (altOfTargets.length > 0) params.set('altOfTargets', altOfTargets.join(','));
  return fetchJson<{ matches: DuplicateMatch[] }>(`/api/duplicate-check?${params}`).then((r) => r.matches);
}

/** Mirrors api/src/handlers/upstreamCitations.ts's UpstreamCitationInput: names
 * the Wiktionary etymology this word IS, or explains why it has none. The client
 * sends only the id - the server takes the content pin from its own corpus, so a
 * stale or hand-edited client cannot poison drift detection. */
export type UpstreamCitationInput = { entryId: string } | { exemptReason: string };

/** 0018's publication overrides, on both creation calls.
 *
 * Sent only when the entry has no citation pin to read them from - i.e. the off-path word and
 * the locally composed phrase. A cited entry leaves them absent, and the generator reads
 * pin.pos / pin.glosses instead. */
export interface PublicationFields {
  pos?: string | null;
  englishGloss?: string | null;
  etymidLabel?: string | null;
}

// Mirrors functions/maintenance.ts's response. Counts only - the plan is thousands of rows on a
// real corpus and the screen shows totals.
export interface AuthoringVoteBackfillResult {
  applied: boolean;
  planned: number;
  plannedEntry: number;
  plannedEtymology: number;
  skippedNoComponents: number;
  skippedAlreadyVoted: number;
  skippedAlreadyDecided: number;
  written?: number;
  failed?: Array<{ wordId: string; axis: string; error: string }>;
}

/** Plans the authoring-vote backfill, and with apply=true performs it. */
export function backfillAuthoringVotes(apply: boolean): Promise<AuthoringVoteBackfillResult> {
  return fetchJson('/api/maintenance/authoring-votes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apply }),
  });
}

// Mirrors api/src/handlers/createWord.ts's CreateWordInput.
export interface CreateWordInput extends PublicationFields {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition?: string | null;
  citation: UpstreamCitationInput;
  /** word_ids this word is built from, in order. Optional and usually absent - most words are
   * atomic, which is zero rows rather than a placeholder. Not the word's identity the way a
   * phrase's components are its identity; see createWord.ts. */
  components?: string[];
}

export function createWord(input: CreateWordInput): Promise<{ wordId: string }> {
  return fetchJson('/api/words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// Mirrors api/src/handlers/createPhrase.ts's CreatePhraseInput.
export interface CreatePhraseInput extends PublicationFields {
  wordId: string;
  displayText: string;
  syllables: string[];
  components: string[];
  /** The student-facing meaning. Seeded on the screen from the dictionary-style English gloss and
   * editable from there - see createPhrase.ts for why they are two columns rather than one. */
  definition?: string | null;
  /** The phrase's OWN etymology, when upstream has an entry for the whole phrase. Was missing
   * from this type while the screen already sent it - the excess-property check does not fire
   * through a conditional spread, so it compiled and the field was simply undocumented here. */
  citation?: { entryId: string };
}

export function createPhrase(input: CreatePhraseInput): Promise<{ wordId: string }> {
  return fetchJson('/api/phrases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// Mirrors api/src/handlers/submitContribution.ts's SubmitContributionInput -
// a volunteer's (or curator's) proposed decision, applied only once a
// curator approves it. Same flat per-axis field shape as the direct
// decision endpoints (POST /api/decisions/{axis}), plus axis + wordId.
export function submitEntryContribution(wordId: string, input: ApplyEntryDecisionInput): Promise<{ contributionId: string }> {
  return fetchJson('/api/contributions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ axis: 'entry', wordId, ...input }),
  });
}

export function submitEtymologyContribution(wordId: string, input: ApplyEtymologyDecisionInput): Promise<{ contributionId: string }> {
  return fetchJson('/api/contributions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ axis: 'etymology', wordId, ...input }),
  });
}

// Mirrors api/src/handlers/resolveOrRequestComponent.ts's ResolveOrRequestResult.
export interface ComponentRequestResult {
  /** The word_id to use as a component. Already exists when `outcome` is 'resolved';
   * will exist once a curator approves otherwise. Never shown to a volunteer - it is a
   * key, and `displayText` is the word. */
  wordId: string;
  outcome: 'resolved' | 'requested' | 'already_requested';
  displayText: string;
  contributionId?: string;
}

/** "The part I mean is this Wiktionary etymology." Resolves to a word we already hold, or
 * queues a request for the curators - either way the caller gets a word_id it can submit
 * immediately, which is what lets a volunteer finish the task now. */
export function requestComponent(entryId: string): Promise<ComponentRequestResult> {
  return fetchJson('/api/component-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });
}

/** The rare path: a word Wiktionary does not have either. Same endpoint and same result shape,
 * so the caller treats it identically - the difference is stored as an exempt citation rather
 * than an entry id, which is also the durable record that it awaits an upstream entry. */
export function requestUnlistedWord(displayText: string, definition: string): Promise<ComponentRequestResult> {
  return fetchJson('/api/component-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayText, definition }),
  });
}

// Mirrors api/src/handlers/listContributions.ts's ContributionListItem.
export interface ContributionListItem {
  contributionId: string;
  wordId: string | null;
  wordDisplayText: string | null;
  /** 'spelling'/'definition' only appear on pre-merge rows a curator already
   * reviewed - see api/src/handlers/listContributions.ts. */
  axis: 'entry' | 'etymology' | 'new_entry' | 'spelling' | 'definition';
  proposedValue: unknown;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  status: string;
  /** For 'new_entry' rows: the words whose etymology submissions already name the word this
   * request would create. Empty on every other axis. */
  waitingWords: Array<{ wordId: string | null; displayText: string | null }>;
}

/** The shape of a 'new_entry' contribution's proposedValue, as
 * api/src/handlers/submitContribution.ts writes it. */
export interface NewEntryProposal {
  proposedWordId: string;
  displayText: string;
  syllables: string[];
  type: 'word' | 'phrase';
  definition?: string;
  components?: string[];
  citation?: { entryId: string } | { exemptReason: string };
}

/** Defaults to 'active' - 0013 replaced the pending/approved/rejected verdict
 * vocabulary. This is no longer the curator's main surface; see getConsensus. */
export function getContributions(status = 'active'): Promise<ContributionListItem[]> {
  return fetchJson<{ contributions: ContributionListItem[] }>(`/api/contributions?status=${encodeURIComponent(status)}`).then(
    (r) => r.contributions,
  );
}

/** Only valid for 'new_entry' contributions. Proposing a word that does not
 * exist yet is authorship, so it is still approved individually; entry and
 * etymology are settled by confirming the consensus instead, and the server
 * rejects an attempt to approve one of those. */
export function approveContribution(contributionId: string): Promise<void> {
  return fetchJson(`/api/contributions/${encodeURIComponent(contributionId)}/approve`, { method: 'POST' });
}

/** Replaces rejectContribution. Removes a contribution from the consensus
 * tally - spam, abuse, test data - while leaving what it says intact. */
export function excludeContribution(contributionId: string, reason?: string): Promise<void> {
  return fetchJson(`/api/contributions/${encodeURIComponent(contributionId)}/exclude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

// Mirrors api/src/handlers/reconcileUpstream.ts. Which cited entries Wiktionary
// has moved under, classified by what kind of move it was.
export type DriftKind = 'unchanged' | 'content_changed' | 're_identified' | 'disappeared';

export interface DriftItem {
  wordId: string;
  displayText: string;
  citedEntryId: string;
  kind: DriftKind;
  pin: UpstreamPin;
  current?: UpstreamPin;
  proposedEntryId?: string;
}

export interface ExemptItem {
  wordId: string;
  displayText: string;
  exemptReason: string;
}

export interface UpstreamDriftResult {
  items: DriftItem[];
  counts: Record<DriftKind, number>;
  exempt: number;
  uncited: number;
  /** The exempt words themselves. A word with no upstream entry is recorded, not omitted - and
   * this is what makes that record findable when Wiktionary finally gains the entry. */
  exemptItems: ExemptItem[];
}

export function getUpstreamDrift(): Promise<UpstreamDriftResult> {
  return fetchJson('/api/upstream-drift');
}

/** Re-pins one word, taking a fresh copy of what upstream says now. Pass a
 * different entryId to re-link it. Never touches golden_record: a pin records
 * what UPSTREAM said, not what we say, so our spelling and student definition
 * survive either way. */
export function repinUpstream(wordId: string, entryId: string): Promise<void> {
  return fetchJson('/api/upstream-drift/repin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wordId, entryId }),
  });
}

// Mirrors api/src/handlers/listConsensus.ts's ConsensusGroup - the curator
// review queue, one row per (word, axis) rather than per contribution.
// ConsensusSummary/ConsensusBucket come from shared, so the bucketing rules
// have exactly one definition.
export interface ConsensusGroup {
  wordId: string;
  displayText: string;
  currentDefinition: string | null;
  axis: 'entry' | 'etymology';
  decidedAt: string | null;
  decidedByEmail: string | null;
  summary: ConsensusSummary;
}

export function getConsensus(options: { buckets?: ConsensusBucket[]; axis?: 'entry' | 'etymology' } = {}): Promise<
  ConsensusGroup[]
> {
  const params = new URLSearchParams();
  if (options.buckets?.length) params.set('buckets', options.buckets.join(','));
  if (options.axis) params.set('axis', options.axis);
  const query = params.toString();
  return fetchJson<{ groups: ConsensusGroup[] }>(`/api/consensus${query ? `?${query}` : ''}`).then((r) => r.groups);
}

// Mirrors api/src/handlers/confirmConsensus.ts.
export interface ConfirmConsensusItem {
  wordId: string;
  axis: 'entry' | 'etymology';
  /** The fingerprint the curator was looking at. The server refuses the item if
   * the winning claim has changed since - which is exactly the hazard in a bulk
   * confirm, where the queue may be minutes old. */
  expectedFingerprint?: string;
  note?: string;
}

export interface ConfirmConsensusResult {
  confirmed: Array<{ wordId: string; axis: string; fingerprint: string; agreementCount: number }>;
  skipped: Array<{ wordId: string; axis: string; reason: string; detail?: string }>;
}

export function confirmConsensus(items: ConfirmConsensusItem[]): Promise<ConfirmConsensusResult> {
  return fetchJson('/api/consensus/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

// Audio is sent inline (base64) and stored directly in Postgres, not
// Azure Blob Storage - see db/migrations/0005_utterance_inline_audio.sql
// and registerUtterance.ts's file header for the short-term rationale.
// Clips here are short (single word / single syllable), so base64 JSON
// overhead is negligible.
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

// Mirrors api/src/handlers/registerUtterance.ts's RegisterUtteranceInput/Result.
export interface RegisterSegmentInput {
  syllablePosition: number;
  startTimeS: number;
  endTimeS: number;
  confidence: number;
  clip: Blob;
}

export interface RegisterUtteranceInput {
  wordId: string;
  takeNumber: number;
  audio: Blob;
  // The pronunciation actually spoken in this recording - may diverge
  // from golden_record's current spelling/syllabification (e.g. recorded
  // before a later spelling decision converged on something else).
  recordedDisplayText: string;
  recordedSyllables: string[];
  durationS?: number;
  sampleRate?: number;
  segments?: RegisterSegmentInput[];
}

export async function registerUtterance(input: RegisterUtteranceInput): Promise<{ utteranceId: string }> {
  const body = {
    wordId: input.wordId,
    takeNumber: input.takeNumber,
    audioDataBase64: await blobToBase64(input.audio),
    recordedDisplayText: input.recordedDisplayText,
    recordedSyllables: input.recordedSyllables,
    durationS: input.durationS,
    sampleRate: input.sampleRate,
    segments: input.segments
      ? await Promise.all(
          input.segments.map(async (segment) => ({
            syllablePosition: segment.syllablePosition,
            startTimeS: segment.startTimeS,
            endTimeS: segment.endTimeS,
            confidence: segment.confidence,
            audioDataBase64: await blobToBase64(segment.clip),
          })),
        )
      : undefined,
  };
  return fetchJson('/api/utterances/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Mirrors api/src/handlers/listUtterances.ts's UtteranceSummary/
// UtteranceSegmentSummary - read-only playback of every recording
// registered for a word, across every speaker (recordings aren't
// login-scoped, so there's no "view as a speaker" - any authenticated
// user can already listen to any speaker's recordings).
export interface UtteranceSegmentSummary {
  syllablePosition: number;
  syllableText: string;
  startTimeS: number;
  endTimeS: number;
  vadConfidence: number | null;
  audioDataBase64: string;
  // Exactly as sliced, before any trimming/normalization - equal to
  // audioDataBase64 until a real processing step exists.
  rawAudioDataBase64: string;
}

export interface UtteranceSummary {
  utteranceId: string;
  speakerId: string;
  speakerDisplayName: string;
  // Whether this recording's speaker is the current user's own speaker
  // identity - lets the UI separate "your recordings" from "other
  // speakers' recordings" instead of blending them.
  isOwnRecording: boolean;
  takeNumber: number;
  status: string;
  recordedDisplayText: string;
  recordedSyllables: string[];
  /** The pronunciation this was recorded under no longer matches the word's
   * current spelling or syllables, so the publish step will silently drop it.
   * Computed server-side with the publish step's own comparison. */
  divergesFromGolden: boolean;
  durationS: number | null;
  sampleRate: number | null;
  recordedAt: string;
  audioDataBase64: string | null;
  rawAudioDataBase64: string | null;
  segments: UtteranceSegmentSummary[];
}

export function listUtterances(wordId: string): Promise<UtteranceSummary[]> {
  return fetchJson<{ utterances: UtteranceSummary[] }>(`/api/words/${encodeURIComponent(wordId)}/utterances`).then(
    (r) => r.utterances,
  );
}

// Mirrors api/src/handlers/submitExample.ts and listExamples.ts - the example axis.
export type ExampleType = 'derived_term' | 'derived_phrase' | 'usage_phrase';

export interface ExampleSummary {
  exampleId: string;
  exampleType: ExampleType;
  exampleText: string;
  translation: string;
  audioDataBase64: string;
  submittedAt: string;
  contributorLabel: string;
  isOwn: boolean;
  recordedWordText: string;
  /** The word has been respelled since this example was contributed. The example may
   * still be fine; it is surfaced rather than silently ignored. */
  wordTextChanged: boolean;
}

export function getExamples(wordId: string): Promise<ExampleSummary[]> {
  return fetchJson<{ examples: ExampleSummary[] }>(`/api/words/${encodeURIComponent(wordId)}/examples`).then(
    (r) => r.examples,
  );
}

/** All three parts together - the phrase, what it means, and hearing it said. An example
 * missing any of them is not an example, so there is no partial submit. */
export async function submitExample(
  wordId: string,
  input: { exampleType: ExampleType; exampleText: string; translation: string; audio: Blob },
): Promise<{ exampleId: string }> {
  return fetchJson(`/api/words/${encodeURIComponent(wordId)}/examples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      exampleType: input.exampleType,
      exampleText: input.exampleText,
      translation: input.translation,
      audioBase64: await blobToBase64(input.audio),
    }),
  });
}

/** Inverse of blobToBase64 - turns a base64 string back into a playable
 * Blob URL for an <audio> element. */
export function base64ToAudioUrl(base64: string, mimeType = 'audio/wav'): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

// Mirrors api/src/handlers/contributionGrants.ts's GrantStatus - what this account has
// agreed to about its own contributions, and whether the app should ask.
export interface GrantStatus {
  releaseState: 'unknown' | 'declined' | 'revoked' | 'agreed';
  acceptedVersion: string | null;
  currentVersion: string;
  needsAcceptance: boolean;
  /** False for an account that declined or withdrew. Every write endpoint refuses one, so
   * the app shows the agreement rather than letting someone work into a 403. */
  canContribute: boolean;
}

export function getMyGrant(): Promise<GrantStatus> {
  return fetchJson('/api/grants/me');
}

export interface RecordGrantInput {
  termsVersion: string;
  /** Present means declined; absent means agreed. An acceptance carries nothing else,
   * because the agreement assigns everything and there is no per-person permission to
   * assert. */
  declineReason?: string;
}

export function recordMyGrant(input: RecordGrantInput): Promise<GrantStatus> {
  return fetchJson('/api/grants/me', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

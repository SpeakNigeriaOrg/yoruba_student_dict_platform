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
  ComponentsAxisFieldsResult,
  DiagnoseEntryResult,
  KaikkiSearchResult,
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
}

export function getMyAssignments(): Promise<AssignmentSummary[]> {
  return fetchJson('/api/assignments/me');
}

// Mirrors api/src/reviewShared.ts's AxisDecided - whether each of the three
// review axes already has a word_decisions row, shown as read-only context
// on every review screen.
export interface AxisDecided {
  spelling: boolean;
  definition: boolean;
  etymology: boolean;
}

// Mirrors api/src/handlers/getEtymologyReview.ts's EtymologyReviewResult.
export interface EtymologyReviewResult extends ComponentsAxisFieldsResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  axisDecided: AxisDecided;
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

// Mirrors api/src/handlers/getSpellingReview.ts's SpellingReviewResult.
export interface SpellingReviewResult extends DiagnoseEntryResult, CheckSyllableSplitResult {
  syllables: string[];
  definition: string | null;
  axisDecided: AxisDecided;
}

export function getSpellingReview(wordId: string): Promise<SpellingReviewResult> {
  return fetchJson(`/api/words/${encodeURIComponent(wordId)}/spelling`);
}

// Mirrors api/src/handlers/applySpellingDecision.ts's ApplySpellingDecisionInput.
export interface ApplySpellingDecisionInput {
  action?: 'keep_ours' | 'select_candidate' | 'adopt_kaikki';
  candidateForm?: string;
  newDisplayText?: string;
  syllableAction?: 'keep_manual' | 'accept_programmatic';
  syllableNote?: string;
  note?: string;
}

export function postSpellingDecision(wordId: string, input: ApplySpellingDecisionInput): Promise<void> {
  return fetchJson(`/api/decisions/spelling`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wordId, ...input }),
  });
}

// Mirrors api/src/handlers/getDefinitionReview.ts's DefinitionReviewResult.
export interface DefinitionReviewResult extends CheckDefinitionResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  axisDecided: AxisDecided;
}

export function getDefinitionReview(wordId: string): Promise<DefinitionReviewResult> {
  return fetchJson(`/api/words/${encodeURIComponent(wordId)}/definition`);
}

// Mirrors api/src/handlers/applyDefinitionDecision.ts's ApplyDefinitionDecisionInput.
export interface ApplyDefinitionDecisionInput {
  definitionAction: 'confirm' | 'custom';
  definitionText?: string;
  definitionSourceForm?: string;
  note?: string;
}

export function postDefinitionDecision(wordId: string, input: ApplyDefinitionDecisionInput): Promise<void> {
  return fetchJson(`/api/decisions/definition`, {
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

// Mirrors api/src/handlers/createWord.ts's CreateWordInput.
export interface CreateWordInput {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition?: string | null;
}

export function createWord(input: CreateWordInput): Promise<{ wordId: string }> {
  return fetchJson('/api/words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// Mirrors api/src/handlers/createPhrase.ts's CreatePhraseInput.
export interface CreatePhraseInput {
  wordId: string;
  displayText: string;
  syllables: string[];
  components: string[];
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
export function submitSpellingContribution(wordId: string, input: ApplySpellingDecisionInput): Promise<{ contributionId: string }> {
  return fetchJson('/api/contributions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ axis: 'spelling', wordId, ...input }),
  });
}

export function submitDefinitionContribution(wordId: string, input: ApplyDefinitionDecisionInput): Promise<{ contributionId: string }> {
  return fetchJson('/api/contributions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ axis: 'definition', wordId, ...input }),
  });
}

export function submitEtymologyContribution(wordId: string, input: ApplyEtymologyDecisionInput): Promise<{ contributionId: string }> {
  return fetchJson('/api/contributions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ axis: 'etymology', wordId, ...input }),
  });
}

// Mirrors api/src/handlers/listContributions.ts's ContributionListItem.
export interface ContributionListItem {
  contributionId: string;
  wordId: string | null;
  wordDisplayText: string | null;
  axis: 'spelling' | 'definition' | 'etymology' | 'new_entry';
  proposedValue: unknown;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  status: string;
}

export function getContributions(status = 'pending'): Promise<ContributionListItem[]> {
  return fetchJson<{ contributions: ContributionListItem[] }>(`/api/contributions?status=${encodeURIComponent(status)}`).then(
    (r) => r.contributions,
  );
}

export function approveContribution(contributionId: string): Promise<void> {
  return fetchJson(`/api/contributions/${encodeURIComponent(contributionId)}/approve`, { method: 'POST' });
}

export function rejectContribution(contributionId: string): Promise<void> {
  return fetchJson(`/api/contributions/${encodeURIComponent(contributionId)}/reject`, { method: 'POST' });
}

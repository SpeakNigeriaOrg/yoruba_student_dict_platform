// api.ts
//
// Thin fetch wrapper over api/'s endpoints - not a generated client, just
// the handful this app actually calls. Relative /api/* paths match SWA's
// own routing convention (same origin once deployed, no CORS config
// needed). Response shapes mirror api/'s own handler return types exactly
// (api/'s handlers aren't published as an importable package the way
// shared/ is, so these are hand-kept in sync, same as identity.ts already
// does for ClientPrincipal).

import type { ComponentsAxisFieldsResult } from '@yoruba-student-dict-platform/shared';

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

// Mirrors api/src/handlers/getEtymologyReview.ts's EtymologyReviewResult.
export interface EtymologyReviewResult extends ComponentsAxisFieldsResult {
  wordId: string;
  displayText: string;
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

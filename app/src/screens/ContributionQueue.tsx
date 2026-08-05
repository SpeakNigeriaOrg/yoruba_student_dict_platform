// screens/ContributionQueue.tsx
//
// Curator-only approval queue: lists pending contributions (volunteer or
// curator proposals awaiting review) with Approve/Reject actions. Real
// gaps this closes: submitContribution.ts/approveContribution.ts both
// existed with no way to list pending ones or decline one outright - a
// curator could apply or ignore-forever, never actually reject.

import { useEffect, useState } from 'react';
import {
  approveContribution,
  getContributions,
  rejectContribution,
  type ContributionListItem,
} from '../api.js';

/** Human labels for the fields a proposed_value can carry. Same flat
 * vocabulary the decision endpoints use (see api/src/handlers/
 * applyEntryDecision.ts), so this covers both halves of an entry proposal and
 * etymology's own fields. */
const FIELD_LABELS: Record<string, string> = {
  action: 'Spelling',
  candidateForm: 'Candidate',
  newDisplayText: 'New spelling',
  syllableAction: 'Syllables',
  syllableNote: 'Syllable note',
  definitionAction: 'Definition',
  definitionText: 'Definition text',
  definitionSourceForm: 'Definition source',
  componentsAction: 'Components',
  components: 'Component words',
  proposedWordId: 'Word ID',
  displayText: 'Spelling',
  syllables: 'Syllables',
  type: 'Type',
};

const VALUE_LABELS: Record<string, string> = {
  keep_ours: 'keep ours',
  adopt_kaikki: "adopt Kaikki's",
  select_candidate: 'use selected candidate',
  keep_manual: 'keep manual split',
  accept_programmatic: 'accept programmatic split',
  confirm: 'confirm current',
  custom: 'custom text',
  confirm_atomic: 'atomic (no parts)',
  confirm_existing: 'confirm existing parts',
  reject_proposed: 'reject proposal',
  accept_proposed: 'accept proposal',
};

/** Renders proposed_value as labelled rows. It was JSON.stringify'd, which on
 * a phone card is a single unreadable line - and this is the screen a curator
 * makes approve/reject decisions from. */
function ProposedValue({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return null;

  return (
    <ul aria-label="Proposed value" className="plain-list proposed-value">
      {entries.map(([key, v]) => (
        <li key={key}>
          <span className="proposed-key">{FIELD_LABELS[key] ?? key}:</span>{' '}
          {Array.isArray(v)
            ? v.join(', ')
            : typeof v === 'string'
              ? (VALUE_LABELS[v] ?? v)
              : String(v)}
        </li>
      ))}
    </ul>
  );
}

/** Locale-formatted rather than a raw ISO string. Falls back to the original
 * text if it isn't parseable, so a bad value shows something rather than
 * "Invalid Date". */
function formatSubmittedAt(submittedAt: string): string {
  const parsed = new Date(submittedAt);
  if (Number.isNaN(parsed.getTime())) return submittedAt;
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ContributionQueue() {
  const [contributions, setContributions] = useState<ContributionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function reload() {
    getContributions('pending')
      .then(setContributions)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(reload, []);

  async function approve(contributionId: string) {
    try {
      await approveContribution(contributionId);
      setStatus(`Approved contribution ${contributionId}.`);
      reload();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function reject(contributionId: string) {
    try {
      await rejectContribution(contributionId);
      setStatus(`Rejected contribution ${contributionId}.`);
      reload();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <p role="alert" className="error-banner">Couldn't load contributions: {error}</p>;
  if (!contributions) return <p>Loading contributions...</p>;

  return (
    <section aria-label="Contribution queue">
      {contributions.length === 0 ? (
        <p>No pending contributions.</p>
      ) : (
        <ul aria-label="Pending contributions" className="card-list">
          {contributions.map((c) => (
            <li key={c.contributionId} className="card-row">
              <strong>{c.axis}</strong>
              {c.wordId ? (
                <>
                  {' '}
                  on {c.wordDisplayText ?? c.wordId} ({c.wordId})
                </>
              ) : null}
              <br />
              <ProposedValue value={c.proposedValue} />
              Submitted by {c.submittedBy} · {formatSubmittedAt(c.submittedAt)}
              {c.note ? (
                <>
                  <br />
                  Note: {c.note}
                </>
              ) : null}
              <div className="btn-row">
                <button type="button" className="btn btn-primary" onClick={() => approve(c.contributionId)}>
                  Approve
                </button>
                <button type="button" className="btn btn-danger" onClick={() => reject(c.contributionId)}>
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

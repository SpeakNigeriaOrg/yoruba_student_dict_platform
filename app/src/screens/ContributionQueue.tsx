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

  if (error) return <p role="alert">Couldn't load contributions: {error}</p>;
  if (!contributions) return <p>Loading contributions...</p>;

  return (
    <section aria-label="Contribution queue">
      {contributions.length === 0 ? (
        <p>No pending contributions.</p>
      ) : (
        <ul aria-label="Pending contributions">
          {contributions.map((c) => (
            <li key={c.contributionId}>
              <strong>{c.axis}</strong>
              {c.wordId ? (
                <>
                  {' '}
                  on {c.wordDisplayText ?? c.wordId} ({c.wordId})
                </>
              ) : null}
              <br />
              Proposed: {JSON.stringify(c.proposedValue)}
              <br />
              Submitted by {c.submittedBy} at {c.submittedAt}
              {c.note ? (
                <>
                  <br />
                  Note: {c.note}
                </>
              ) : null}
              <br />
              <button type="button" onClick={() => approve(c.contributionId)}>
                Approve
              </button>
              <button type="button" onClick={() => reject(c.contributionId)}>
                Reject
              </button>
            </li>
          ))}
        </ul>
      )}
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}

// screens/AdminUserDetail.tsx
//
// Curator-only detail view for one user's assigned words: per-word
// AxisStatusBadges (decided or not, same as every other word list) plus
// AxisReviewBadges (this admin feature's own not_started/in_review/passed
// per axis), an Unassign action per row (ContributionQueue.tsx's own
// approve/reject/reload shape), and the assign-more-words form
// (WordAssignPicker).

import { useEffect, useState } from 'react';
import { assignWords, getUserAssignments, unassignWord, type UserAssignmentSummary } from '../api.js';
import { AxisStatusBadges } from './AxisStatusBadges.js';
import { AxisReviewBadges } from './AxisReviewBadges.js';
import { WordAssignPicker } from './WordAssignPicker.js';

export interface AdminUserDetailProps {
  userId: string;
  onBack: () => void;
  onSelectWord: (wordId: string) => void;
  /** Notifies the parent user list to re-fetch its own summary counts
   * after an assign/unassign here changes them. */
  onUsersChanged: () => void;
}

export function AdminUserDetail({ userId, onBack, onSelectWord, onUsersChanged }: AdminUserDetailProps) {
  const [assignments, setAssignments] = useState<UserAssignmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function reload() {
    getUserAssignments(userId)
      .then(setAssignments)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(reload, [userId]);

  async function handleAssign(wordIds: string[]) {
    try {
      const result = await assignWords(userId, wordIds);
      setStatus(
        `Assigned ${result.created.length} word(s).` +
          (result.alreadyAssigned.length > 0 ? ` (${result.alreadyAssigned.length} were already assigned.)` : ''),
      );
      reload();
      onUsersChanged();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUnassign(wordId: string) {
    try {
      await unassignWord(userId, wordId);
      setStatus(`Unassigned ${wordId}.`);
      reload();
      onUsersChanged();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section aria-label="User assignment detail">
      <button type="button" className="back-btn" onClick={onBack}>
        ← Back
      </button>

      <WordAssignPicker onAssign={handleAssign} />

      {error ? <p role="alert" className="error-banner">Couldn't load assignments: {error}</p> : null}
      {!assignments ? (
        <p>Loading assignments...</p>
      ) : assignments.length === 0 ? (
        <p>No words assigned to this user.</p>
      ) : (
        <ul aria-label="Assigned words" className="card-list">
          {assignments.map((a) => (
            <li key={a.wordId} className="card-row">
              <button type="button" className="row-title" onClick={() => onSelectWord(a.wordId)}>
                {a.displayText}
              </button>
              {a.definition ? <span> — {a.definition}</span> : null}
              <br />
              <AxisStatusBadges axisDecided={a.axisDecided} />
              <br />
              <AxisReviewBadges reviewStatus={a.reviewStatus} />
              <div className="btn-row">
                <button type="button" className="btn btn-danger" onClick={() => handleUnassign(a.wordId)}>
                  Unassign
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

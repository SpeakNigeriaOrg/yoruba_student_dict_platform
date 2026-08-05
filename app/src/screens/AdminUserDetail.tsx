// screens/AdminUserDetail.tsx
//
// Curator-only detail view for one user's assigned words: per-word
// AxisStatusBadges (decided or not, same as every other word list) plus
// AxisReviewBadges (this admin feature's own not_started/in_review/passed
// per axis), an Unassign action per row (ContributionQueue.tsx's own
// approve/reject/reload shape), and the assign-more-words form
// (WordAssignPicker).

import { useEffect, useState } from 'react';
import {
  assignWords,
  assignWordsByScope,
  getUserAssignments,
  unassignWord,
  type AssignmentScope,
  type UserAssignmentSummary,
} from '../api.js';
import { AxisStatusBadges } from './AxisStatusBadges.js';
import { AxisReviewBadges } from './AxisReviewBadges.js';
import { WordAssignPicker } from './WordAssignPicker.js';

export interface AdminUserDetailProps {
  userId: string;
  onSelectWord: (wordId: string) => void;
  /** Both optional since this is now its own route (#/users/{id}) rather
   * than a child of AdminUsers: the shell renders the back affordance from
   * real history, and the user list re-fetches its counts when it re-mounts,
   * so neither needs threading through. Kept as hooks for callers that do
   * want to react in place. */
  onBack?: () => void;
  onUsersChanged?: () => void;
}

export function AdminUserDetail({ userId, onSelectWord, onBack, onUsersChanged }: AdminUserDetailProps) {
  const [assignments, setAssignments] = useState<UserAssignmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function reload() {
    getUserAssignments(userId)
      .then(setAssignments)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(reload, [userId]);

  async function runAssign(assign: () => Promise<{ created: string[]; alreadyAssigned: string[] }>) {
    try {
      const result = await assign();
      setStatus(
        `Assigned ${result.created.length} word(s).` +
          (result.alreadyAssigned.length > 0 ? ` (${result.alreadyAssigned.length} were already assigned.)` : ''),
      );
      reload();
      onUsersChanged?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAssign(wordIds: string[]) {
    return runAssign(() => assignWords(userId, wordIds));
  }

  function handleAssignScope(scope: AssignmentScope) {
    return runAssign(() => assignWordsByScope(userId, scope));
  }

  async function handleUnassign(wordId: string) {
    try {
      await unassignWord(userId, wordId);
      setStatus(`Unassigned ${wordId}.`);
      reload();
      onUsersChanged?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section aria-label="User assignment detail">
      {/* Only rendered when a caller supplies its own back handling. As a
          route (#/users/{id}) the shell renders one from real history, and a
          second button here would just duplicate it. */}
      {onBack ? (
        <button type="button" className="back-btn" onClick={onBack}>
          ← Back
        </button>
      ) : null}

      <WordAssignPicker onAssign={handleAssign} onAssignScope={handleAssignScope} />

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

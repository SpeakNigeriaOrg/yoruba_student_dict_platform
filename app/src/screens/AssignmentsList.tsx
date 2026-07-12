// screens/AssignmentsList.tsx
//
// GET /api/assignments/me, rendered as a list of the curator's assigned
// words. Selecting one hands off to the word review screen (App.tsx owns
// that transition - this component only reports the selection).

import { useEffect, useState } from 'react';
import { getMyAssignments, type AssignmentSummary } from '../api.js';
import { AxisStatusBadges } from './AxisStatusBadges.js';

export interface AssignmentsListProps {
  onSelect: (wordId: string) => void;
}

export function AssignmentsList({ onSelect }: AssignmentsListProps) {
  const [assignments, setAssignments] = useState<AssignmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyAssignments()
      .then((result) => {
        if (!cancelled) setAssignments(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p role="alert" className="error-banner">Couldn't load your assignments: {error}</p>;
  if (!assignments) return <p>Loading assignments...</p>;
  if (assignments.length === 0) return <p>No words assigned to you right now.</p>;

  return (
    <ul aria-label="My assignments" className="card-list">
      {assignments.map((a) => (
        <li key={a.wordId} className="card-row">
          <button type="button" className="row-title" onClick={() => onSelect(a.wordId)}>
            {a.displayText}
          </button>
          {a.definition ? <span> — {a.definition}</span> : null}
          <br />
          <AxisStatusBadges axisDecided={a.axisDecided} />
        </li>
      ))}
    </ul>
  );
}

// screens/AssignmentsList.tsx
//
// The full "my assigned words" list. No longer the landing screen - TaskQueue
// hands over one task at a time instead - but still reachable from it as an
// escape hatch for someone who wants to see everything they own, or jump to a
// specific word.
//
// `assignments` may be passed in by a caller that has already fetched them
// (TaskQueue has), in which case this skips its own request; omitting it keeps
// the original self-fetching behaviour.

import { useEffect, useState } from 'react';
import { getMyAssignments, type AssignmentSummary } from '../api.js';
import { AxisStatusBadges } from './AxisStatusBadges.js';

export interface AssignmentsListProps {
  onSelect: (wordId: string) => void;
  assignments?: AssignmentSummary[];
}

export function AssignmentsList({ onSelect, assignments: provided }: AssignmentsListProps) {
  const [fetched, setFetched] = useState<AssignmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (provided) return;
    let cancelled = false;
    getMyAssignments()
      .then((result) => {
        if (!cancelled) setFetched(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [provided]);

  const assignments = provided ?? fetched;

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

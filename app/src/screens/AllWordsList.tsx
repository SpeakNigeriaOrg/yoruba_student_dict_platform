// screens/AllWordsList.tsx
//
// GET /api/words - browse every word, not just "my assignments" (curator-
// only, matches the backend's curator gate). Old tool precedent:
// resolver.js always showed all words per axis tab with a single "hide
// confirmed" toggle - this is the equivalent, but per-axis since this
// platform already splits decided-status three ways, and filtered
// client-side since the dataset is small.

import { useEffect, useState } from 'react';
import { getAllWords, type AllWordsListItem } from '../api.js';
import { AxisStatusBadges } from './AxisStatusBadges.js';

export interface AllWordsListProps {
  onSelect: (wordId: string) => void;
}

export function AllWordsList({ onSelect }: AllWordsListProps) {
  const [words, setWords] = useState<AllWordsListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textFilter, setTextFilter] = useState('');
  const [hideEntryDecided, setHideEntryDecided] = useState(false);
  const [hideEtymologyDecided, setHideEtymologyDecided] = useState(false);

  useEffect(() => {
    getAllWords()
      .then(setWords)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <p role="alert" className="error-banner">Couldn't load all words: {error}</p>;
  if (!words) return <p>Loading all words...</p>;

  const filtered = words.filter((w) => {
    if (textFilter && !w.displayText.toLowerCase().includes(textFilter.toLowerCase()) && !w.wordId.includes(textFilter)) {
      return false;
    }
    if (hideEntryDecided && w.axisDecided.entry) return false;
    if (hideEtymologyDecided && w.axisDecided.etymology) return false;
    return true;
  });

  return (
    <section aria-label="Browse all words">
      <div className="field">
        <input
          type="text"
          placeholder="Filter by spelling or word_id..."
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          aria-label="Filter words"
        />
      </div>
      <div aria-label="Hide decided filters">
        <label className="field-inline">
          <input type="checkbox" checked={hideEntryDecided} onChange={(e) => setHideEntryDecided(e.target.checked)} />
          Hide entry-decided
        </label>
        <label className="field-inline">
          <input type="checkbox" checked={hideEtymologyDecided} onChange={(e) => setHideEtymologyDecided(e.target.checked)} />
          Hide etymology-decided
        </label>
      </div>

      {filtered.length === 0 ? (
        <p>No words match the current filters.</p>
      ) : (
        <ul aria-label="All words" className="card-list">
          {filtered.map((w) => {
            // All four, including example - otherwise a word with three axes done renders as
            // complete while the task queue still counts a task outstanding on it.
            const allDecided =
              w.axisDecided.entry && w.axisDecided.etymology && w.axisDecided.audio && w.axisDecided.example;
            return (
              <li key={w.wordId} className={`card-row${allDecided ? ' decided' : ''}`}>
                <button type="button" className="row-title" onClick={() => onSelect(w.wordId)}>
                  {w.displayText}
                </button>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--ink-soft)' }}> ({w.wordId})</span>
                <br />
                <AxisStatusBadges axisDecided={w.axisDecided} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

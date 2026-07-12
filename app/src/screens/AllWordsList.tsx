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

export interface AllWordsListProps {
  onSelect: (wordId: string) => void;
}

export function AllWordsList({ onSelect }: AllWordsListProps) {
  const [words, setWords] = useState<AllWordsListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textFilter, setTextFilter] = useState('');
  const [hideSpellingDecided, setHideSpellingDecided] = useState(false);
  const [hideDefinitionDecided, setHideDefinitionDecided] = useState(false);
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
    if (hideSpellingDecided && w.axisDecided.spelling) return false;
    if (hideDefinitionDecided && w.axisDecided.definition) return false;
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
          <input type="checkbox" checked={hideSpellingDecided} onChange={(e) => setHideSpellingDecided(e.target.checked)} />
          Hide spelling-decided
        </label>
        <label className="field-inline">
          <input type="checkbox" checked={hideDefinitionDecided} onChange={(e) => setHideDefinitionDecided(e.target.checked)} />
          Hide definition-decided
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
            const allDecided = w.axisDecided.spelling && w.axisDecided.definition && w.axisDecided.etymology;
            return (
              <li key={w.wordId} className={`card-row${allDecided ? ' decided' : ''}`}>
                <button type="button" className="row-title" onClick={() => onSelect(w.wordId)}>
                  {w.displayText}
                </button>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--ink-soft)' }}> ({w.wordId})</span>
                <br />
                <span className={`badge${w.axisDecided.spelling ? ' decided' : ''}`}>
                  spelling: {w.axisDecided.spelling ? 'decided' : 'not yet decided'}
                </span>{' '}
                <span className={`badge${w.axisDecided.definition ? ' decided' : ''}`}>
                  definition: {w.axisDecided.definition ? 'decided' : 'not yet decided'}
                </span>{' '}
                <span className={`badge${w.axisDecided.etymology ? ' decided' : ''}`}>
                  etymology: {w.axisDecided.etymology ? 'decided' : 'not yet decided'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// screens/AllWordsList.tsx
//
// GET /api/words - browse every word, not just "my assignments" (curator-
// only, matches the backend's curator gate). Old tool precedent:
// resolver.js always showed all words per axis tab with a single "hide
// confirmed" toggle - this is the equivalent, but per-axis since this
// platform already splits decided-status three ways, and filtered
// client-side since the dataset is small.
//
// ---------------------------------------------------------------------------
// There is ONE search engine, and this screen now uses it
// ---------------------------------------------------------------------------
// This box used to be `displayText.toLowerCase().includes(query.toLowerCase())` - a second,
// private matching rule, and much the weakest one in the app. Being codepoint-exact after case
// folding, it required the reader to reproduce a spelling they are searching for precisely
// BECAUSE they cannot see it:
//
//   composition   `ẹ̀` has no single codepoint - it is a base plus a combining grave - so whether
//                 the underdot is precomposed (U+1EB9) or its own mark decided whether `fi sílẹ̀`
//                 matched `fi sílẹ̀`. The two render identically, both are correct input, and
//                 production holds text in either form.
//   tone          `fi sile` found nothing, though it is the phrase without the marks a phone
//                 keyboard cannot produce.
//   underdot      the same again for ẹ ọ ṣ, which is what the composer's palette exists for.
//
// The consequence is not a fussy filter, it is a false negative where it costs most: browsing is
// how a curator asks "do we already hold this?" before adding it. `fi sílẹ̀` reported no results
// while `fi_sile_leave_it` sat in the list, and the next step after no results is to create the
// duplicate.
//
// searchVocab is that question already answered - exact, then tone-insensitive, then
// orthography-insensitive, then prefix, then word_id, then English definition tokens - and it is
// what the component picker, the etymology widget and the assignment picker all search with,
// through /api/vocab-search. Run here over the list already loaded rather than through the
// endpoint, because the rows carry per-axis decided state that a search result does not, and
// re-fetching would only reunite them.

import { useEffect, useMemo, useState } from 'react';
import { searchVocab, type Vocab } from '@yoruba-student-dict-platform/shared';
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

  // The list projected into the shape the shared engine searches. Memoised on the loaded rows
  // rather than rebuilt per keystroke, and declared above the early returns so the hook order is
  // the same on every render.
  const vocab = useMemo<Vocab>(
    () =>
      Object.fromEntries(
        (words ?? []).map((w) => [
          w.wordId,
          {
            displayText: w.displayText,
            syllables: w.syllables,
            ...(w.definition ? { definition: w.definition } : {}),
            ...(w.entryType === 'phrase' ? { type: 'phrase' as const } : {}),
          },
        ]),
      ),
    [words],
  );
  const byWordId = useMemo(() => new Map((words ?? []).map((w) => [w.wordId, w])), [words]);

  if (error) return <p role="alert" className="error-banner">Couldn't load all words: {error}</p>;
  if (!words) return <p>Loading all words...</p>;

  // Ranked order while a query is active, list order when it is not. A search that has decided
  // which match is best should say so, and word_id order is the right default for browsing.
  const ranked = textFilter.trim()
    ? searchVocab(vocab, textFilter, words.length).map((r) => byWordId.get(r.wordId)!)
    : words;
  const filtered = ranked.filter((w) => {
    if (hideEntryDecided && w.axisDecided.entry) return false;
    if (hideEtymologyDecided && w.axisDecided.etymology) return false;
    return true;
  });

  return (
    <section aria-label="Browse all words">
      <div className="field">
        <input
          type="text"
          placeholder="Search by spelling, word_id or meaning - tone marks optional..."
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

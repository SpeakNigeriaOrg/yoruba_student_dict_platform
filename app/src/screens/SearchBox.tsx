// screens/SearchBox.tsx
//
// Reusable manual-search widget: query input + results list + a
// per-result "use this" action, generic over the result type - used by
// SpellingReview (searchKaikki -> select_candidate), DefinitionReview
// (searchKaikki -> definitionSourceForm), and EtymologyReview
// (searchVocab -> add a manual component), rather than building three
// near-identical search widgets by hand. Old tool precedent:
// resolver.js's kaikkiSearchHtml/etymologyManualPickerHtml, both hitting
// Enter-to-submit + a "Use this"/"Add" button per result.

import { useEffect, useRef, useState } from 'react';

export interface SearchBoxProps<T> {
  search: (query: string) => Promise<T[]>;
  renderResult: (result: T) => React.ReactNode;
  onSelect: (result: T) => void | Promise<void>;
  selectLabel?: string;
  selectedLabel?: string;
  selectingLabel?: string;
  placeholder?: string;
  resultsAriaLabel: string;
  /** Pre-fills the query and runs the search once on mount - for callers
   * that already know roughly what to search for (e.g. a Kaikki-proposed
   * component spelling that isn't in our vocab yet), rather than making
   * the user retype something already known. */
  initialQuery?: string;
  /** Marks the caller's current pick, so a chosen row stays visibly chosen.
   *
   * Selection state stays with the CALLER rather than moving in here: three of the four callers keep
   * it in their own form state (or do not have a single "current" pick at all, like the phrase tab's
   * growing component list), and duplicating it would give two sources of truth for one fact. */
  isSelected?: (result: T) => boolean;
  /** Replaces the select button for ONE result. Return null to keep the default.
   *
   * For a result the caller cannot accept: offering "Select" on something that will be refused is
   * worse than offering nothing, because the refusal arrives after the form is filled in. */
  renderAction?: (result: T) => React.ReactNode;
  /** Reports what the reader has typed, for a caller that needs the QUERY rather than a result.
   *
   * Add Word's off-path branch is the case: someone searches for a word, does not find it, and says
   * so - and the spelling they want is the thing they just typed. The query was private to this
   * component, so that branch opened with an empty field and asked them to type it again. Optional,
   * because it is the only caller that has anything to do with a query that matched nothing. */
  onQueryChange?: (query: string) => void;
  /** Names this search box, for a screen that has more than one.
   *
   * The Phrase tab has two - one over the dictionary, one over Wiktionary - and unlabelled they present
   * as two identical anonymous searches with two identical "Search" buttons. Ambiguous to assistive
   * technology, not merely to a test. Omitted by the other callers, which have only one. */
  label?: string;
  /** Single-pick searches can get out of the user's way once a choice is made. */
  collapseOnSelect?: boolean;
}

export function SearchBox<T>({
  search,
  renderResult,
  onSelect,
  selectLabel = 'Use this',
  selectedLabel = 'Selected ✓',
  selectingLabel = 'Selecting…',
  placeholder,
  resultsAriaLabel,
  initialQuery,
  isSelected,
  renderAction,
  onQueryChange,
  label,
  collapseOnSelect = false,
}: SearchBoxProps<T>) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [results, setResults] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectingIndex, setSelectingIndex] = useState<number | null>(null);
  const searchSequence = useRef(0);

  async function runSearch(searchQuery = query) {
    const sequence = ++searchSequence.current;
    setError(null);
    setSearching(true);
    try {
      const next = await search(searchQuery);
      if (sequence === searchSequence.current) setResults(next);
    } catch (err) {
      if (sequence === searchSequence.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sequence === searchSequence.current) setSearching(false);
    }
  }

  async function select(result: T, index: number) {
    if (selectingIndex !== null) return;
    setSelectingIndex(index);
    setError(null);
    try {
      await onSelect(result);
      if (collapseOnSelect) setResults(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectingIndex(null);
    }
  }

  useEffect(() => {
    if (initialQuery) runSearch(initialQuery);
    // Only ever auto-runs once, on mount, from whatever initialQuery was
    // passed in at that time - not re-run if the prop identity changes,
    // same "seed the starting point, then it's the user's own input"
    // behavior as an uncontrolled form field's defaultValue.
  }, []);

  return (
    <div role={label ? 'search' : undefined} aria-label={label} aria-busy={searching || selectingIndex !== null}>
      <div className="search-row">
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            onQueryChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
        />
        <button type="button" className="btn btn-secondary" onClick={() => runSearch()} disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error ? <p role="alert" className="error-banner">{error}</p> : null}
      {results ? (
        results.length === 0 ? (
          <p>No results.</p>
        ) : (
          <ul aria-label={resultsAriaLabel} className="plain-list">
            {/* Both new props default to absent, and when they are the markup below is exactly what it
                was - which is what lets the other three callers and their tests stay untouched. */}
            {results.map((result, i) => {
              const selected = isSelected?.(result) ?? false;
              const action = renderAction?.(result);
              return (
                <li
                  key={i}
                  className={selected ? 'search-result-row selected' : 'search-result-row'}
                  aria-current={selected ? 'true' : undefined}
                >
                  <span className="result-text">{renderResult(result)}</span>
                  {action ?? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void select(result, i)}
                      disabled={selected || selectingIndex !== null}
                    >
                      {selectingIndex === i ? selectingLabel : selected ? selectedLabel : selectLabel}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}

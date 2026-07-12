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

import { useState } from 'react';

export interface SearchBoxProps<T> {
  search: (query: string) => Promise<T[]>;
  renderResult: (result: T) => React.ReactNode;
  onSelect: (result: T) => void;
  selectLabel?: string;
  placeholder?: string;
  resultsAriaLabel: string;
}

export function SearchBox<T>({
  search,
  renderResult,
  onSelect,
  selectLabel = 'Use this',
  placeholder,
  resultsAriaLabel,
}: SearchBoxProps<T>) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    setError(null);
    try {
      setResults(await search(query));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="search-row">
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
        />
        <button type="button" className="btn btn-secondary" onClick={runSearch}>
          Search
        </button>
      </div>
      {error ? <p role="alert" className="error-banner">{error}</p> : null}
      {results ? (
        results.length === 0 ? (
          <p>No results.</p>
        ) : (
          <ul aria-label={resultsAriaLabel} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {results.map((result, i) => (
              <li key={i} className="search-result-row">
                <span className="result-text">{renderResult(result)}</span>
                <button type="button" className="btn btn-secondary" onClick={() => onSelect(result)}>
                  {selectLabel}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

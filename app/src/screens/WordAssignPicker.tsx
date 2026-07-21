// screens/WordAssignPicker.tsx
//
// Hybrid word-picker for bulk-assigning words to a user: SearchBox for
// "search and pick one at a time" (accumulated as removable chips rather
// than submitted immediately - the one behavioral difference from
// SearchBox's other callers, all of which submit on first select), plus a
// plain paste-textarea for genuine bulk (e.g. a spreadsheet's worth of
// word_ids). One "Assign" button submits everything accumulated at once.
// Kept as its own component rather than extending SearchBox itself, which
// is already reused 3 times with a single-shot onSelect contract that
// shouldn't have to change for this one caller's needs.

import { useState } from 'react';
import { searchVocab } from '../api.js';
import { SearchBox } from './SearchBox.js';

export interface WordAssignPickerProps {
  onAssign: (wordIds: string[]) => Promise<void>;
}

export function WordAssignPicker({ onAssign }: WordAssignPickerProps) {
  const [pending, setPending] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function addWordId(wordId: string) {
    setPending((prev) => (prev.includes(wordId) ? prev : [...prev, wordId]));
  }

  function removeWordId(wordId: string) {
    setPending((prev) => prev.filter((w) => w !== wordId));
  }

  function mergePastedIds() {
    const ids = pasteText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    setPending((prev) => Array.from(new Set([...prev, ...ids])));
    setPasteText('');
  }

  async function handleAssign() {
    if (pending.length === 0) return;
    setSubmitting(true);
    try {
      await onAssign(pending);
      setPending([]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <SearchBox
        search={searchVocab}
        renderResult={(result) => `${result.displayText} (${result.wordId})`}
        onSelect={(result) => addWordId(result.wordId)}
        selectLabel="Add"
        resultsAriaLabel="Word search results"
        placeholder="Search for a word to assign"
      />
      <div className="field">
        <label htmlFor="paste-word-ids">Or paste word IDs (one per line or comma-separated)</label>
        <textarea id="paste-word-ids" value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={3} />
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={mergePastedIds} disabled={!pasteText.trim()}>
            Add pasted IDs
          </button>
        </div>
      </div>
      {pending.length > 0 ? (
        <div>
          <p>{pending.length} word(s) pending assignment:</p>
          <ul aria-label="Pending word assignments" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {pending.map((wordId) => (
              <li key={wordId}>
                {wordId}{' '}
                <button type="button" className="btn-danger" onClick={() => removeWordId(wordId)} aria-label={`Remove ${wordId}`}>
                  x
                </button>
              </li>
            ))}
          </ul>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={handleAssign} disabled={submitting}>
              {submitting ? 'Assigning...' : `Assign ${pending.length} word(s)`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

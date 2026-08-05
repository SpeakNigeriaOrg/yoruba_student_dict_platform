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
//
// Alongside those, two whole-vocabulary shortcuts (all words / all words
// still missing a verification layer). They don't go through `pending`:
// the server resolves the word set at submit time, so the curator can't
// act on a list that went stale, and the UI never has to hold thousands
// of chips. Both are two-step (click, then confirm) since there's no
// bulk unassign to walk them back.

import { useState } from 'react';
import { searchVocab, type AssignmentScope } from '../api.js';
import { SearchBox } from './SearchBox.js';

export interface WordAssignPickerProps {
  onAssign: (wordIds: string[]) => Promise<void>;
  onAssignScope: (scope: AssignmentScope) => Promise<void>;
}

const SCOPE_LABELS: Record<AssignmentScope, string> = {
  all: 'all words',
  incomplete: 'all incomplete words',
};

export function WordAssignPicker({ onAssign, onAssignScope }: WordAssignPickerProps) {
  const [pending, setPending] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [armedScope, setArmedScope] = useState<AssignmentScope | null>(null);

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

  async function handleAssignScope(scope: AssignmentScope) {
    setSubmitting(true);
    try {
      await onAssignScope(scope);
      setArmedScope(null);
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
          <ul aria-label="Pending word assignments" className="plain-list">
            {pending.map((wordId) => (
              <li key={wordId}>
                {wordId}{' '}
                <button type="button" className="btn btn-danger" onClick={() => removeWordId(wordId)} aria-label={`Remove ${wordId}`}>
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
      <div className="field">
        {armedScope ? (
          <>
            <p role="alert">Assign {SCOPE_LABELS[armedScope]} to this user? Words already assigned are left as they are.</p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleAssignScope(armedScope)}
                disabled={submitting}
              >
                {submitting ? 'Assigning...' : `Yes, assign ${SCOPE_LABELS[armedScope]}`}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setArmedScope(null)} disabled={submitting}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setArmedScope('all')} disabled={submitting}>
              Assign all words
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setArmedScope('incomplete')}
              disabled={submitting}
            >
              Assign all incomplete words
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

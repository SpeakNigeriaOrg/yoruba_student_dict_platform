// screens/DefinitionReview.tsx
//
// GET /api/words/{wordId}/definition - the definition axis. Mirrors
// EtymologyReview.tsx/SpellingReview.tsx's structure. checkDefinition's
// `definitionStatus` already encodes the interesting cases (confirmed/
// pending_custom/missing/proposed/invalid_override) - rendered directly.
//
// Free-text custom definition, a note field, and a manual Kaikki search
// to redirect the definition source were all previously missing here -
// the old tool's resolver.js supported all three (a directly-editable
// textarea, definitionNote, and a meaning-link search box respectively).

import { useEffect, useState } from 'react';
import type { KaikkiSearchResult } from '@yoruba-student-dict-platform/shared';
import {
  getDefinitionReview,
  postDefinitionDecision,
  searchKaikki,
  submitDefinitionContribution,
  type ApplyDefinitionDecisionInput,
  type DefinitionReviewResult,
} from '../api.js';
import { AxisBanner } from './AxisBanner.js';
import { SearchBox } from './SearchBox.js';

export interface DefinitionReviewProps {
  wordId: string;
  isCurator: boolean;
}

export function DefinitionReview({ wordId, isCurator }: DefinitionReviewProps) {
  const [review, setReview] = useState<DefinitionReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [note, setNote] = useState('');
  const [sourceForm, setSourceForm] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    getDefinitionReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        setDraftText(result.definitionCurrent ?? result.definitionProposed ?? '');
        setNote(result.definitionNote ?? '');
        setSourceForm(result.definitionSourceForm ?? undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function submit(input: ApplyDefinitionDecisionInput, successMessage: string) {
    try {
      if (isCurator) {
        await postDefinitionDecision(wordId, input);
        setStatus(successMessage);
      } else {
        await submitDefinitionContribution(wordId, input);
        setStatus(`Proposed: ${successMessage}`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmCurrent() {
    await submit({ definitionAction: 'confirm', note: note || undefined }, 'Confirmed the current definition.');
  }

  async function acceptProposed() {
    if (!review?.definitionProposed) return;
    await submit(
      { definitionAction: 'custom', definitionText: review.definitionProposed, note: note || undefined },
      `Accepted proposed definition: ${review.definitionProposed}`,
    );
  }

  async function saveCustomText() {
    if (!draftText.trim()) {
      setStatus('Enter a definition first.');
      return;
    }
    await submit(
      { definitionAction: 'custom', definitionText: draftText, definitionSourceForm: sourceForm, note: note || undefined },
      `Saved custom definition: ${draftText}`,
    );
  }

  function useSearchResultAsSource(result: KaikkiSearchResult) {
    setSourceForm(result.form);
    if (result.glosses.length > 0) setDraftText(result.glosses[0]);
  }

  if (error) return <p role="alert" className="error-banner">Couldn't load definition data: {error}</p>;
  if (!review) return <p>Loading definition data...</p>;

  const label = (text: string) => (isCurator ? text : `Propose: ${text}`);

  return (
    <section aria-label="Definition review" className={`card${review.axisDecided.definition ? ' decided' : ''}`}>
      <AxisBanner
        displayText={review.displayText}
        syllables={review.syllables}
        definition={review.definitionCurrent}
        axisDecided={review.axisDecided}
        currentAxis="Definition"
      />

      <p aria-label="Definition diagnosis">
        <strong>Status:</strong> {review.definitionStatus}
        {review.definitionProposed ? (
          <>
            <br />
            Proposed (from Kaikki{review.definitionSourceForm ? `, via ${review.definitionSourceForm}` : ''}):{' '}
            <strong>{review.definitionProposed}</strong>
          </>
        ) : null}
      </p>

      <div className="field">
        <label htmlFor="definition-text-field">Definition text</label>
        <textarea
          id="definition-text-field"
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          aria-label="Definition text"
        />
      </div>

      <div className="field">
        <label htmlFor="definition-note-field">Note</label>
        <textarea id="definition-note-field" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      </div>

      <h3>Search Kaikki for a different definition source</h3>
      <SearchBox
        search={searchKaikki}
        renderResult={(r) => (
          <>
            <strong>{r.form}</strong> ({r.pos}) - {r.glosses.join('; ')}
          </>
        )}
        onSelect={useSearchResultAsSource}
        selectLabel="Use as definition source"
        placeholder="Search Kaikki..."
        resultsAriaLabel="Kaikki search results"
      />

      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={confirmCurrent} disabled={!review.definitionCurrent}>
          {label('Confirm current definition')}
        </button>
        <button type="button" className="btn btn-primary" onClick={acceptProposed} disabled={!review.definitionProposed}>
          {label('Accept proposed definition')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={saveCustomText}>
          {label('Save as custom text')}
        </button>
      </div>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

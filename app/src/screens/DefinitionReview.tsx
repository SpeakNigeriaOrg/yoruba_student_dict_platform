// screens/DefinitionReview.tsx
//
// GET /api/words/{wordId}/definition - the definition axis. Mirrors
// EtymologyReview.tsx/SpellingReview.tsx's structure. checkDefinition's
// `definitionStatus` already encodes the interesting cases (confirmed/
// pending_custom/missing/proposed/invalid_override) - rendered directly.

import { useEffect, useState } from 'react';
import { getDefinitionReview, postDefinitionDecision, type DefinitionReviewResult } from '../api.js';
import { AxisBanner } from './AxisBanner.js';

export interface DefinitionReviewProps {
  wordId: string;
}

export function DefinitionReview({ wordId }: DefinitionReviewProps) {
  const [review, setReview] = useState<DefinitionReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    getDefinitionReview(wordId)
      .then((result) => {
        if (!cancelled) setReview(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function confirmCurrent() {
    try {
      await postDefinitionDecision(wordId, { definitionAction: 'confirm' });
      setStatus('Confirmed the current definition.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function acceptProposed() {
    if (!review?.definitionProposed) return;
    try {
      await postDefinitionDecision(wordId, { definitionAction: 'custom', definitionText: review.definitionProposed });
      setStatus(`Accepted proposed definition: ${review.definitionProposed}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <p role="alert">Couldn't load definition data: {error}</p>;
  if (!review) return <p>Loading definition data...</p>;

  return (
    <section aria-label="Definition review">
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
        {review.definitionNote ? (
          <>
            <br />
            {review.definitionNote}
          </>
        ) : null}
      </p>

      <div>
        <button type="button" onClick={confirmCurrent} disabled={!review.definitionCurrent}>
          Confirm current definition
        </button>
        <button type="button" onClick={acceptProposed} disabled={!review.definitionProposed}>
          Accept proposed definition
        </button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}

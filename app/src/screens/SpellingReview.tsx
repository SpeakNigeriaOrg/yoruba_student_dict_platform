// screens/SpellingReview.tsx
//
// GET /api/words/{wordId}/spelling - the spelling/tone axis. Mirrors
// EtymologyReview.tsx's structure. diagnoseEntry's `status` already
// encodes the interesting cases (match/tone_mismatch/underdot_mismatch/
// not_in_kaikki/ambiguous_match/matched_alternative_form/already-decided
// verified_keep_ours/decided_adopt_kaikki) - rendered directly rather than
// re-deriving anything client-side.

import { useEffect, useState } from 'react';
import { getSpellingReview, postSpellingDecision, type SpellingReviewResult } from '../api.js';
import { AxisBanner } from './AxisBanner.js';

export interface SpellingReviewProps {
  wordId: string;
}

export function SpellingReview({ wordId }: SpellingReviewProps) {
  const [review, setReview] = useState<SpellingReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    getSpellingReview(wordId)
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

  async function keepOurs() {
    try {
      await postSpellingDecision(wordId, { action: 'keep_ours' });
      setStatus('Kept our own spelling.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function adoptKaikki() {
    if (!review?.adoptionTarget) return;
    try {
      await postSpellingDecision(wordId, { action: 'adopt_kaikki', newDisplayText: review.adoptionTarget });
      setStatus(`Adopted Kaikki's spelling: ${review.adoptionTarget}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <p role="alert">Couldn't load spelling data: {error}</p>;
  if (!review) return <p>Loading spelling data...</p>;

  return (
    <section aria-label="Spelling review">
      <AxisBanner
        displayText={review.displayText}
        syllables={review.syllables}
        definition={review.definition}
        axisDecided={review.axisDecided}
        currentAxis="Spelling"
      />

      <p aria-label="Spelling diagnosis">
        <strong>Status:</strong> {review.status}
        {review.matchedForm ? (
          <>
            <br />
            Kaikki's matched form: <strong>{review.matchedForm}</strong>
          </>
        ) : null}
        {review.adoptionTarget && review.adoptionTarget !== review.displayText ? (
          <>
            <br />
            Suggested adoption target: <strong>{review.adoptionTarget}</strong>
          </>
        ) : null}
      </p>

      {review.candidatesConsidered && review.candidatesConsidered.length > 0 ? (
        <>
          <h3>Candidates considered (ambiguous match - needs manual selection)</h3>
          <ul aria-label="Candidates considered">
            {review.candidatesConsidered.map((c, i) => (
              <li key={i}>
                <strong>{c.form}</strong> ({c.pos}) - {c.glosses.join('; ')}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div>
        <button type="button" onClick={keepOurs}>
          Keep our spelling
        </button>
        <button type="button" onClick={adoptKaikki} disabled={!review.adoptionTarget}>
          Adopt Kaikki's spelling
        </button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}

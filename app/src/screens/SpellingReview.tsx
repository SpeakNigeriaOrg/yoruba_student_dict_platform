// screens/SpellingReview.tsx
//
// GET /api/words/{wordId}/spelling - the spelling/tone axis. Mirrors
// EtymologyReview.tsx's structure. diagnoseEntry's `status` already
// encodes the interesting cases (match/tone_mismatch/underdot_mismatch/
// not_in_kaikki/ambiguous_match/matched_alternative_form/already-decided
// verified_keep_ours/decided_adopt_kaikki) - rendered directly rather than
// re-deriving anything client-side.
//
// Picking among ambiguous candidates, a manual Kaikki search fallback, a
// note field, and the syllable-split sub-check were all previously
// missing here - the old tool's resolver.js supported all four
// (candidate radios, a search box, a note textarea, and a manual-vs-
// programmatic syllable comparison respectively).

import { useEffect, useState } from 'react';
import {
  getSpellingReview,
  postSpellingDecision,
  searchKaikki,
  submitSpellingContribution,
  type ApplySpellingDecisionInput,
  type SpellingReviewResult,
} from '../api.js';
import { AxisBanner } from './AxisBanner.js';
import { SearchBox } from './SearchBox.js';

export interface SpellingReviewProps {
  wordId: string;
  /** Curators decide directly (POST /decisions/spelling); everyone else
   * proposes a contribution instead (POST /contributions), pending a
   * curator's approval - same data shape either way. */
  isCurator: boolean;
}

export function SpellingReview({ wordId, isCurator }: SpellingReviewProps) {
  const [review, setReview] = useState<SpellingReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setSelectedCandidate(null);
    getSpellingReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        setNote(result.note ?? '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function submit(input: ApplySpellingDecisionInput, successMessage: string) {
    try {
      if (isCurator) {
        await postSpellingDecision(wordId, input);
        setStatus(successMessage);
      } else {
        await submitSpellingContribution(wordId, input);
        setStatus(`Proposed: ${successMessage}`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function keepOurs() {
    await submit({ action: 'keep_ours', note: note || undefined }, 'Kept our own spelling.');
  }

  async function adoptKaikki() {
    if (!review?.adoptionTarget) return;
    await submit(
      { action: 'adopt_kaikki', newDisplayText: review.adoptionTarget, note: note || undefined },
      `Adopted Kaikki's spelling: ${review.adoptionTarget}`,
    );
  }

  async function confirmSelectedCandidate() {
    if (!selectedCandidate) {
      setStatus('Select a candidate first.');
      return;
    }
    await submit(
      { action: 'select_candidate', candidateForm: selectedCandidate, note: note || undefined },
      `Confirmed candidate: ${selectedCandidate}`,
    );
  }

  async function useSearchResultAsCandidate(form: string) {
    await submit({ action: 'select_candidate', candidateForm: form, note: note || undefined }, `Confirmed candidate: ${form}`);
  }

  async function keepManualSyllables() {
    await submit({ syllableAction: 'keep_manual', syllableNote: note || undefined }, 'Kept the manual syllable split.');
  }

  async function acceptProgrammaticSyllables() {
    await submit(
      { syllableAction: 'accept_programmatic', syllableNote: note || undefined },
      `Accepted programmatic split: ${review?.syllableSplitProgrammatic?.join(' · ')}`,
    );
  }

  if (error) return <p role="alert" className="error-banner">Couldn't load spelling data: {error}</p>;
  if (!review) return <p>Loading spelling data...</p>;

  const label = (text: string) => (isCurator ? text : `Propose: ${text}`);

  return (
    <section aria-label="Spelling review" className={`card${review.axisDecided.spelling ? ' decided' : ''}`}>
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
                <label>
                  <input
                    type="radio"
                    name="candidate"
                    value={c.form}
                    checked={selectedCandidate === c.form}
                    onChange={() => setSelectedCandidate(c.form)}
                  />
                  <strong>{c.form}</strong> ({c.pos}) - {c.glosses.join('; ')}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-primary" onClick={confirmSelectedCandidate}>
            {label('Confirm selected candidate')}
          </button>
        </>
      ) : null}

      <h3>Search Kaikki manually</h3>
      <SearchBox
        search={searchKaikki}
        renderResult={(r) => (
          <>
            <strong>{r.form}</strong> ({r.pos}) - {r.glosses.join('; ')}
          </>
        )}
        onSelect={(r) => useSearchResultAsCandidate(r.form)}
        selectLabel={label('Use this')}
        placeholder="Search Kaikki..."
        resultsAriaLabel="Kaikki search results"
      />

      {review.syllableSplitStatus === 'mismatch' ? (
        <>
          <h3>Syllable split</h3>
          <div className="comparison" aria-label="Syllable split comparison">
            <div className="col">
              <div className="col-label">Manual</div>
              {review.syllableSplitManual?.join(' · ')}
            </div>
            <div className="col">
              <div className="col-label">Programmatic</div>
              {review.syllableSplitProgrammatic?.join(' · ')}
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={keepManualSyllables}>
              {label('Keep manual split')}
            </button>
            <button type="button" className="btn btn-primary" onClick={acceptProgrammaticSyllables}>
              {label('Accept programmatic split')}
            </button>
          </div>
        </>
      ) : null}

      <div className="field">
        <label htmlFor="spelling-note-field">Note</label>
        <textarea id="spelling-note-field" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={keepOurs}>
          {label('Keep our spelling')}
        </button>
        <button type="button" className="btn btn-primary" onClick={adoptKaikki} disabled={!review.adoptionTarget}>
          {label("Adopt Kaikki's spelling")}
        </button>
      </div>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

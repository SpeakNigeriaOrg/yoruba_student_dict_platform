// screens/EntryReview.tsx
//
// GET /api/words/{wordId}/entry - the entry axis: a word's written form AND
// its meaning, reviewed as ONE task. Replaces SpellingReview.tsx and
// DefinitionReview.tsx.
//
// The important change is the button topology, not the layout. Those two
// screens had five submit buttons between them, each writing a fragment
// immediately: "Keep our spelling" posted a spelling decision on its own,
// "Confirm current definition" posted a definition decision on its own, and
// a word could end up with its form blessed and its sense unreviewed.
//
// Here every spelling control (keep ours / adopt Kaikki / candidate radios /
// manual Kaikki search) only SELECTS into local state, the definition
// textarea is edited in place, and one primary "Confirm entry" button
// submits both halves together. Nothing is written until then, which is also
// what makes "accept the spelling but rewrite the definition" expressible -
// it was two separate round trips before.

import { useEffect, useState } from 'react';
import type { KaikkiSearchResult } from '@yoruba-student-dict-platform/shared';
import {
  getEntryReview,
  postEntryDecision,
  searchKaikki,
  submitEntryContribution,
  type ApplyEntryDecisionInput,
  type EntryReviewResult,
} from '../api.js';
import { AxisBanner } from './AxisBanner.js';
import { SearchBox } from './SearchBox.js';

export interface EntryReviewProps {
  wordId: string;
  /** Curators decide directly (POST /decisions/entry); everyone else
   * proposes a contribution instead (POST /contributions), pending a
   * curator's approval - same data shape either way. */
  isCurator: boolean;
  /** Called after a successful submit, so the task queue can advance. Absent
   * when this screen is reached directly (browse, admin), where staying put
   * is the right behaviour. */
  onDecided?: () => void;
}

/** The written-form half of the pending decision. Held as one value rather
 * than loose fields so the UI can render exactly which choice is armed, and
 * so submitting can't accidentally send two conflicting actions. */
type SpellingChoice =
  | { action: 'keep_ours' }
  | { action: 'adopt_kaikki'; newDisplayText: string }
  | { action: 'select_candidate'; candidateForm: string };

export function EntryReview({ wordId, isCurator, onDecided }: EntryReviewProps) {
  const [review, setReview] = useState<EntryReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pending decision, both halves.
  const [spelling, setSpelling] = useState<SpellingChoice | null>(null);
  const [syllableAction, setSyllableAction] = useState<'keep_manual' | 'accept_programmatic' | undefined>(undefined);
  const [definitionText, setDefinitionText] = useState('');
  const [definitionSourceForm, setDefinitionSourceForm] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setStatus(null);
    setSpelling(null);
    setSyllableAction(undefined);
    getEntryReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        setDefinitionText(result.definitionCurrent ?? result.definitionProposed ?? '');
        setDefinitionSourceForm(result.definitionSourceForm ?? undefined);
        setNote(result.note ?? '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  /** Picking a Kaikki record from the search box arms it as the spelling
   * candidate AND retargets the definition source, since that is the one
   * action where a human is saying "this record is the right one" about the
   * entry as a whole. Carried over from DefinitionReview's own behaviour of
   * updating source and draft text together. */
  function useSearchResult(result: KaikkiSearchResult) {
    setSpelling({ action: 'select_candidate', candidateForm: result.form });
    setDefinitionSourceForm(result.form);
    if (result.glosses.length > 0) setDefinitionText(result.glosses[0]);
  }

  async function submit() {
    if (!review) return;
    if (!spelling) {
      setStatus('Choose the spelling first - an entry is decided as a whole.');
      return;
    }
    if (!definitionText.trim()) {
      setStatus('Enter a definition first - an entry is decided as a whole.');
      return;
    }

    // 'confirm' only means anything when the text is unchanged from what is
    // already on record; any edit is a custom definition.
    const unchanged = definitionText.trim() === (review.definitionCurrent ?? '').trim();
    const input: ApplyEntryDecisionInput = {
      ...spelling,
      ...(syllableAction ? { syllableAction } : {}),
      ...(unchanged
        ? { definitionAction: 'confirm' as const }
        : { definitionAction: 'custom' as const, definitionText: definitionText.trim() }),
      ...(definitionSourceForm ? { definitionSourceForm } : {}),
      ...(note ? { note } : {}),
    };

    setSubmitting(true);
    try {
      if (isCurator) {
        await postEntryDecision(wordId, input);
        setStatus('Entry confirmed: spelling and definition recorded together.');
      } else {
        await submitEntryContribution(wordId, input);
        setStatus('Proposed: spelling and definition, for a curator to approve.');
      }
      const refreshed = await getEntryReview(wordId);
      setReview(refreshed);
      onDecided?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load entry data: {error}
      </p>
    );
  if (!review) return <p>Loading entry data...</p>;

  const canAdopt = Boolean(review.adoptionTarget);
  const readyToSubmit = Boolean(spelling) && definitionText.trim().length > 0;

  return (
    <section aria-label="Entry review" className={`card${review.axisDecided.entry ? ' decided' : ''}`}>
      <AxisBanner
        displayText={review.displayText}
        syllables={review.syllables}
        definition={review.definitionCurrent}
        axisDecided={review.axisDecided}
        currentAxis="Entry"
      />

      <h3>Written form</h3>
      <p aria-label="Spelling diagnosis">
        <strong>Status:</strong> {review.status}
        {review.matchedForm ? (
          <>
            <br />
            Kaikki's matched form: <strong>{review.matchedForm}</strong>
          </>
        ) : null}
      </p>

      <div className="btn-row" role="group" aria-label="Spelling choice">
        <button
          type="button"
          className={`btn ${spelling?.action === 'keep_ours' ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={spelling?.action === 'keep_ours'}
          onClick={() => setSpelling({ action: 'keep_ours' })}
        >
          Keep our spelling ({review.displayText})
        </button>
        <button
          type="button"
          className={`btn ${spelling?.action === 'adopt_kaikki' ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={spelling?.action === 'adopt_kaikki'}
          disabled={!canAdopt}
          onClick={() =>
            review.adoptionTarget && setSpelling({ action: 'adopt_kaikki', newDisplayText: review.adoptionTarget })
          }
        >
          {canAdopt ? `Adopt Kaikki's spelling (${review.adoptionTarget})` : "Adopt Kaikki's spelling"}
        </button>
      </div>

      {review.candidatesConsidered && review.candidatesConsidered.length > 0 ? (
        <>
          <h3>Candidates considered (ambiguous match - needs manual selection)</h3>
          <ul aria-label="Candidates considered" className="plain-list">
            {review.candidatesConsidered.map((c, i) => (
              <li key={i}>
                <label>
                  <input
                    type="radio"
                    name="candidate"
                    value={c.form}
                    checked={spelling?.action === 'select_candidate' && spelling.candidateForm === c.form}
                    onChange={() => setSpelling({ action: 'select_candidate', candidateForm: c.form })}
                  />
                  <strong>{c.form}</strong> ({c.pos}) - {c.glosses.join('; ')}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}

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
          <div className="btn-row" role="group" aria-label="Syllable split choice">
            <button
              type="button"
              className={`btn ${syllableAction === 'keep_manual' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={syllableAction === 'keep_manual'}
              onClick={() => setSyllableAction('keep_manual')}
            >
              Keep manual split
            </button>
            <button
              type="button"
              className={`btn ${syllableAction === 'accept_programmatic' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={syllableAction === 'accept_programmatic'}
              onClick={() => setSyllableAction('accept_programmatic')}
            >
              Accept programmatic split
            </button>
          </div>
        </>
      ) : null}

      <h3>Meaning</h3>
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
        <label htmlFor="entry-definition-field">Definition text</label>
        <textarea
          id="entry-definition-field"
          value={definitionText}
          onChange={(e) => setDefinitionText(e.target.value)}
          aria-label="Definition text"
        />
      </div>
      {review.definitionProposed && definitionText.trim() !== review.definitionProposed.trim() ? (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => review.definitionProposed && setDefinitionText(review.definitionProposed)}
        >
          Use proposed definition
        </button>
      ) : null}

      <h3>Search Kaikki manually</h3>
      <p className="field-note">Picking a record sets both the spelling candidate and the definition source.</p>
      <SearchBox
        search={searchKaikki}
        renderResult={(r) => (
          <>
            <strong>{r.form}</strong> ({r.pos}) - {r.glosses.join('; ')}
          </>
        )}
        onSelect={useSearchResult}
        selectLabel="Use this record"
        placeholder="Search Kaikki..."
        resultsAriaLabel="Kaikki search results"
      />

      <div className="field">
        <label htmlFor="entry-note-field">Note</label>
        <textarea id="entry-note-field" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      </div>

      <button type="button" className="btn btn-primary" onClick={submit} disabled={!readyToSubmit || submitting}>
        {isCurator ? 'Confirm entry' : 'Propose: Confirm entry'}
      </button>
      {!readyToSubmit ? (
        <p className="field-note">Spelling and definition are decided together - choose a spelling and enter a definition.</p>
      ) : null}
      {status ? (
        <p role="status" className="status-banner">
          {status}
        </p>
      ) : null}
    </section>
  );
}

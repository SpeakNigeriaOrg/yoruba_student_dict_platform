// screens/EtymologyReview.tsx
//
// GET /api/words/{wordId}/etymology, both directions rendered for
// reconciliation: componentsProposal (this word's own proposed
// decomposition) and usedInProposal (kaikki-yoruba's etymology-driven
// "which other words use this one as a component" - newly surfaced this
// session, see getEtymologyReview.ts). Neither is auto-applied - a
// curator explicitly accepts/rejects, same as componentsAxisFields's own
// "proposal, not fact" design.
//
// A manual component search/add/remove draft, confirm_existing/
// reject_proposed, and a note field were all previously missing here -
// only accept_proposed (all-or-nothing on the auto-proposal) and
// confirm_atomic were wired. The old tool's resolver.js supported a full
// manual component picker (etymologyManualPickerHtml) independent of
// whatever the automatic proposal suggested.

import { useEffect, useState } from 'react';
import type { ComponentsProposalItem, VocabSearchResult } from '@yoruba-student-dict-platform/shared';
import {
  getEtymologyReview,
  postEtymologyDecision,
  searchVocab,
  submitEtymologyContribution,
  type ApplyEtymologyDecisionInput,
  type EtymologyReviewResult,
} from '../api.js';
import { AxisBanner } from './AxisBanner.js';
import { SearchBox } from './SearchBox.js';

export interface EtymologyReviewProps {
  wordId: string;
  isCurator: boolean;
}

function ProposalItemRow({ item }: { item: ComponentsProposalItem }) {
  return (
    <li>
      <strong>{item.kaikkiForm}</strong>
      {item.wordId ? (
        <span> → resolves to {item.wordId}</span>
      ) : item.ambiguous ? (
        <span> — ambiguous: more than one existing word shares this exact spelling</span>
      ) : item.possibleMatches.length > 0 ? (
        <span> — possibly the same as: {item.possibleMatches.join(', ')} (tone differs, not auto-resolved)</span>
      ) : (
        <span> — not in golden_record yet</span>
      )}
      {item.previewGlosses.length > 0 ? <span> ({item.previewGlosses.join('; ')})</span> : null}
    </li>
  );
}

export function EtymologyReview({ wordId, isCurator }: EtymologyReviewProps) {
  const [review, setReview] = useState<EtymologyReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [draftComponents, setDraftComponents] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setDraftComponents([]);
    getEtymologyReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        // Atomic words report components as [wordId] itself (see
        // getEtymologyReview.ts) - not a real manual pick, start the
        // draft empty in that case rather than pre-seeding a self-chip.
        const isAtomic = result.components.length === 1 && result.components[0] === wordId;
        setDraftComponents(isAtomic ? [] : result.components);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function submit(input: ApplyEtymologyDecisionInput, successMessage: string) {
    try {
      if (isCurator) {
        await postEtymologyDecision(wordId, input);
        setStatus(successMessage);
      } else {
        await submitEtymologyContribution(wordId, input);
        setStatus(`Proposed: ${successMessage}`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function acceptProposedComponents() {
    if (!review) return;
    const resolvedIds = review.componentsProposal.map((p) => p.wordId).filter((id): id is string => id !== null);
    if (resolvedIds.length !== review.componentsProposal.length) {
      setStatus("Can't accept yet - some proposed components don't resolve to a confirmed word_id.");
      return;
    }
    await submit({ componentsAction: 'accept_proposed', components: resolvedIds, note: note || undefined }, 'Accepted proposed components.');
  }

  async function confirmAtomic() {
    await submit({ componentsAction: 'confirm_atomic', note: note || undefined }, 'Confirmed as atomic (no real components).');
  }

  async function confirmExisting() {
    await submit({ componentsAction: 'confirm_existing', note: note || undefined }, 'Confirmed the existing components.');
  }

  async function rejectProposed() {
    await submit({ componentsAction: 'reject_proposed', note: note || undefined }, 'Rejected the proposed etymology - stays atomic.');
  }

  async function saveCustomComponents() {
    await submit(
      { componentsAction: 'custom', components: draftComponents, note: note || undefined },
      `Saved custom components: ${draftComponents.join(', ')}`,
    );
  }

  function addManualComponent(result: VocabSearchResult) {
    setDraftComponents((prev) => (prev.includes(result.wordId) ? prev : [...prev, result.wordId]));
  }

  function removeManualComponent(componentWordId: string) {
    setDraftComponents((prev) => prev.filter((id) => id !== componentWordId));
  }

  const hasRealExistingComponents =
    review !== null && review.components.length > 0 && !(review.components.length === 1 && review.components[0] === wordId);

  if (error) return <p role="alert" className="error-banner">Couldn't load etymology data: {error}</p>;
  if (!review) return <p>Loading etymology data...</p>;

  const label = (text: string) => (isCurator ? text : `Propose: ${text}`);

  return (
    <section aria-label="Etymology review" className={`card${review.axisDecided.etymology ? ' decided' : ''}`}>
      <AxisBanner
        displayText={review.displayText}
        syllables={review.syllables}
        definition={review.definition}
        axisDecided={review.axisDecided}
        currentAxis="Etymology"
      />

      <h3>Proposed components (this word's own decomposition)</h3>
      {review.componentsProposal.length === 0 ? (
        <p>No Kaikki-proposed decomposition for this word.</p>
      ) : (
        <ul aria-label="Proposed components">
          {review.componentsProposal.map((item, i) => (
            <ProposalItemRow key={i} item={item} />
          ))}
        </ul>
      )}

      <h3>Used in (other words that use this one as a component)</h3>
      {review.usedInProposal.length === 0 ? (
        <p>No other words are proposed as using this one.</p>
      ) : (
        <ul aria-label="Used in proposals">
          {review.usedInProposal.map((item, i) => (
            <ProposalItemRow key={i} item={item} />
          ))}
        </ul>
      )}

      <h3>Already confirmed as used in</h3>
      {review.usedAsComponentOf.length === 0 ? (
        <p>No confirmed relationships yet.</p>
      ) : (
        <ul aria-label="Confirmed used in">
          {review.usedAsComponentOf.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}

      <h3>Manually build the component list</h3>
      {draftComponents.length === 0 ? (
        <p>No components picked yet.</p>
      ) : (
        <ul aria-label="Draft components" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {draftComponents.map((componentWordId) => (
            <li key={componentWordId} className="search-result-row">
              <span className="result-text">{componentWordId}</span>
              <button type="button" className="btn btn-danger" onClick={() => removeManualComponent(componentWordId)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <SearchBox
        search={searchVocab}
        renderResult={(r) => (
          <>
            <strong>{r.wordId}</strong> - {r.displayText}
          </>
        )}
        onSelect={addManualComponent}
        selectLabel="Add"
        placeholder="Search existing vocabulary..."
        resultsAriaLabel="Vocab search results"
      />
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={saveCustomComponents}>
          {label('Save custom components')}
        </button>
      </div>

      <div className="field">
        <label htmlFor="etymology-note-field">Note</label>
        <textarea id="etymology-note-field" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={acceptProposedComponents}>
          {label('Accept proposed components')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={confirmAtomic}>
          {label('Confirm atomic (no components)')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={confirmExisting} disabled={!hasRealExistingComponents}>
          {label('Confirm components')}
        </button>
        <button type="button" className="btn btn-danger" onClick={rejectProposed} disabled={review.componentsProposal.length === 0}>
          {label('Reject this etymology')}
        </button>
      </div>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

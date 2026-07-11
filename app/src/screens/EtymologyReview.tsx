// screens/EtymologyReview.tsx
//
// GET /api/words/{wordId}/etymology, both directions rendered for
// reconciliation: componentsProposal (this word's own proposed
// decomposition) and usedInProposal (kaikki-yoruba's etymology-driven
// "which other words use this one as a component" - newly surfaced this
// session, see getEtymologyReview.ts). Neither is auto-applied - a
// curator explicitly accepts/rejects, same as componentsAxisFields's own
// "proposal, not fact" design.

import { useEffect, useState } from 'react';
import type { ComponentsProposalItem } from '@yoruba-student-dict-platform/shared';
import { getEtymologyReview, postEtymologyDecision, type EtymologyReviewResult } from '../api.js';

export interface EtymologyReviewProps {
  wordId: string;
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

export function EtymologyReview({ wordId }: EtymologyReviewProps) {
  const [review, setReview] = useState<EtymologyReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    getEtymologyReview(wordId)
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

  async function acceptProposedComponents() {
    if (!review) return;
    const resolvedIds = review.componentsProposal.map((p) => p.wordId).filter((id): id is string => id !== null);
    if (resolvedIds.length !== review.componentsProposal.length) {
      setStatus("Can't accept yet - some proposed components don't resolve to a confirmed word_id.");
      return;
    }
    try {
      await postEtymologyDecision(wordId, { componentsAction: 'accept_proposed', components: resolvedIds });
      setStatus('Accepted proposed components.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmAtomic() {
    try {
      await postEtymologyDecision(wordId, { componentsAction: 'confirm_atomic' });
      setStatus('Confirmed as atomic (no real components).');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <p role="alert">Couldn't load etymology data: {error}</p>;
  if (!review) return <p>Loading etymology data...</p>;

  return (
    <section aria-label="Etymology review">
      <h2>{review.displayText}</h2>

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

      <div>
        <button type="button" onClick={acceptProposedComponents}>
          Accept proposed components
        </button>
        <button type="button" onClick={confirmAtomic}>
          Confirm atomic (no components)
        </button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}

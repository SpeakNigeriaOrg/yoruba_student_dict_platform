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
import type { ComponentsProposalItem, KaikkiSearchResult, VocabSearchResult } from '@yoruba-student-dict-platform/shared';
import { orthographyInsensitiveForm, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import {
  createWord,
  getEtymologyReview,
  postEtymologyDecision,
  searchKaikki,
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

// A Kaikki-proposed component that resolves to no existing word_id at
// all (not ambiguous, no tone-shifted near-miss - genuinely absent from
// golden_record) is otherwise a dead end: nothing lets a curator act on
// it. This searches Kaikki (pre-seeded with the candidate's own
// spelling, since that's already known) and creates the missing word,
// which both adds it to golden_record AND resolves this candidate in one
// action, rather than requiring a separate trip through Add Word first.
function AddMissingComponent({ kaikkiForm, onAdded }: { kaikkiForm: string; onAdded: (wordId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<KaikkiSearchResult | null>(null);
  const [selectedForm, setSelectedForm] = useState('');
  const [syllablesText, setSyllablesText] = useState('');
  const [hint, setHint] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  function pickResult(result: KaikkiSearchResult) {
    setSelected(result);
    const form = result.standardForms[0] ?? result.form;
    setSelectedForm(form);
    setSyllablesText(syllabifyWord(form).join(','));
  }

  const wordIdPreview = selectedForm && hint ? `${orthographyInsensitiveForm(selectedForm).replace(/ /g, '_')}_${hint}` : '';

  async function submit() {
    if (!wordIdPreview) {
      setStatus('Enter a word_id hint first.');
      return;
    }
    try {
      const result = await createWord({
        wordId: wordIdPreview,
        displayText: selectedForm,
        syllables: syllablesText.split(',').map((s) => s.trim()).filter(Boolean),
      });
      onAdded(result.wordId);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  if (!expanded) {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setExpanded(true)}>
        Add "{kaikkiForm}" to vocabulary
      </button>
    );
  }

  return (
    <div className="field" aria-label={`Add ${kaikkiForm} to vocabulary`}>
      <SearchBox
        search={searchKaikki}
        initialQuery={kaikkiForm}
        renderResult={(r) => (
          <>
            <strong>{r.form}</strong> ({r.pos}) - {r.glosses.join('; ')}
          </>
        )}
        onSelect={pickResult}
        selectLabel="Select"
        placeholder="Search Kaikki by spelling or meaning..."
        resultsAriaLabel="Kaikki search results for missing component"
      />
      {selected ? (
        <>
          <div className="field">
            <label htmlFor={`missing-component-syllables-${kaikkiForm}`}>Syllables (comma-separated)</label>
            <input
              id={`missing-component-syllables-${kaikkiForm}`}
              type="text"
              value={syllablesText}
              onChange={(e) => setSyllablesText(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`missing-component-hint-${kaikkiForm}`}>Word ID hint (English meaning)</label>
            <input
              id={`missing-component-hint-${kaikkiForm}`}
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value.replace(/\s+/g, '_'))}
            />
          </div>
          <p>
            Word ID: <strong>{wordIdPreview || '(enter a hint)'}</strong>
          </p>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Add & use as component
          </button>
        </>
      ) : null}
      {status ? <p role="alert">{status}</p> : null}
    </div>
  );
}

function ProposalItemRow({ item, onAdded }: { item: ComponentsProposalItem; onAdded: (wordId: string) => void }) {
  const notInVocabYet = !item.wordId && !item.ambiguous && item.possibleMatches.length === 0;
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
      {notInVocabYet ? (
        <div className="btn-row">
          <AddMissingComponent kaikkiForm={item.kaikkiForm} onAdded={onAdded} />
        </div>
      ) : null}
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

  // Re-fetches after a missing component is added to golden_record mid-
  // review (AddMissingComponent) - a fresh load correctly re-resolves
  // that candidate to its new word_id, same as a page reload would,
  // without needing to hand-patch nested proposal state.
  async function refreshAfterAddingComponent() {
    try {
      const result = await getEtymologyReview(wordId);
      setReview(result);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

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
            <ProposalItemRow key={i} item={item} onAdded={refreshAfterAddingComponent} />
          ))}
        </ul>
      )}

      {review.etymologyText ? (
        <div aria-label="Kaikki etymology note" className={review.componentsProposal.length === 0 ? 'warning-banner' : undefined}>
          {review.componentsProposal.length === 0 ? (
            <p>
              <strong>No structured breakdown exists for this word</strong> - Kaikki only has this plaintext
              etymology note:
            </p>
          ) : (
            <p>Kaikki also has this plaintext etymology note, alongside the structured breakdown above:</p>
          )}
          <p><em>{review.etymologyText}</em></p>
        </div>
      ) : null}

      <h3>Used in (other words that use this one as a component)</h3>
      {review.usedInProposal.length === 0 ? (
        <p>No other words are proposed as using this one.</p>
      ) : (
        <ul aria-label="Used in proposals">
          {review.usedInProposal.map((item, i) => (
            <ProposalItemRow key={i} item={item} onAdded={refreshAfterAddingComponent} />
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

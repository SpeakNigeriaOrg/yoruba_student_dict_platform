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
  /** Called after a successful submit, so the task queue can advance. */
  onDecided?: () => void;
  /** Off in the task queue, matching EntryReview. The chips name the same three
   * axes as the tab bar the queue does not show, and in the queue they advertise
   * two other axes to someone handed one specific task. */
  showAxisChips?: boolean;
}

// A Kaikki-proposed component that resolves to no existing word_id at
// all (not ambiguous, no tone-shifted near-miss - genuinely absent from
// golden_record) is otherwise a dead end: nothing lets a curator act on
// it. This searches Kaikki (pre-seeded with the candidate's own
// spelling, since that's already known) and creates the missing word,
// which both adds it to golden_record AND resolves this candidate in one
// action, rather than requiring a separate trip through Add Word first.
//
// The etymology picked here matters more than anywhere else in the app. This is
// the compound case: a derived word must reference ONE etymology of its
// component, not a spelling that maps to several. Creating the component while
// discarding which `kọ́` was meant would put the ambiguity straight into
// golden_record_components, where nothing downstream could resolve it.
//
// No off-path branch here on purpose: a component genuinely absent from
// Wiktionary is a judgement call about a word in its own right, which belongs on
// the Add Word screen with its warning, not buried in resolving a candidate.
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
    if (!selected?.entryId) {
      setStatus('Pick a Kaikki etymology first - a component has to reference one, not just a spelling.');
      return;
    }
    try {
      const result = await createWord({
        wordId: wordIdPreview,
        displayText: selectedForm,
        syllables: syllablesText.split(',').map((s) => s.trim()).filter(Boolean),
        definition: selected.glosses[0] ?? null,
        citation: { entryId: selected.entryId },
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
            <strong>{r.form}</strong> ({r.pos}
            {r.etymologyNumber ? `, etymology ${r.etymologyNumber}` : ''}) - {r.glosses.join('; ')}
          </>
        )}
        onSelect={pickResult}
        selectLabel="Select"
        placeholder="Search Kaikki by spelling or meaning..."
        resultsAriaLabel="Kaikki search results for missing component"
      />
      {selected ? (
        <>
          <p aria-label="Cited etymology for missing component">
            Citing: <strong>{selected.form}</strong> ({selected.pos}
            {selected.etymologyNumber ? `, etymology ${selected.etymologyNumber}` : ''}) -{' '}
            {selected.glosses.join('; ')}
          </p>
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
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!selected.entryId}>
            Add & use as component
          </button>
        </>
      ) : null}
      {status ? <p role="alert">{status}</p> : null}
    </div>
  );
}

function ProposalItemRow({
  item,
  onAdded,
  isCurator,
}: {
  item: ComponentsProposalItem;
  onAdded: (wordId: string) => void;
  isCurator: boolean;
}) {
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
      {/* Adding the missing word posts to POST /api/words, which is curator-only
          both in staticwebapp.config.json and in the handler's own requireCurator.
          Offering it to a volunteer produced a live "403" at the end of a filled-in
          form - the same shape of defect as the /api/contributions route-ordering
          403: a member-facing control wired to a curator-only endpoint. A
          volunteer is told what to do instead. */}
      {notInVocabYet ? (
        isCurator ? (
          <div className="btn-row">
            <AddMissingComponent kaikkiForm={item.kaikkiForm} onAdded={onAdded} />
          </div>
        ) : (
          <p className="field-note">Ask a curator to add this word before it can be linked as a part.</p>
        )
      ) : null}
    </li>
  );
}

export function EtymologyReview({ wordId, isCurator, onDecided, showAxisChips = true }: EtymologyReviewProps) {
  const [review, setReview] = useState<EtymologyReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [draftComponents, setDraftComponents] = useState<string[]>([]);
  const [showTools, setShowTools] = useState(false);
  /** The disagree branch. "It has no parts" is a complete answer on its own; saying it
   * DOES have parts is only half an answer, so it reveals the picker rather than
   * submitting. Available to volunteers - it was curator-only, which is precisely what
   * left the screen with a single clickable answer. */
  const [claimsHasParts, setClaimsHasParts] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setDraftComponents([]);
    setShowTools(false);
    setClaimsHasParts(false);
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
      onDecided?.();
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
  const hasProposal = (review?.componentsProposal.length ?? 0) > 0;

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
        showAxisChips={showAxisChips}
      />

      <h3>Proposed components (this word's own decomposition)</h3>
      {review.componentsProposal.length === 0 ? (
        <p>No Kaikki-proposed decomposition for this word.</p>
      ) : (
        <ul aria-label="Proposed components">
          {review.componentsProposal.map((item, i) => (
            <ProposalItemRow key={i} item={item} onAdded={refreshAfterAddingComponent} isCurator={isCurator} />
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
            <ProposalItemRow key={i} item={item} onAdded={refreshAfterAddingComponent} isCurator={isCurator} />
          ))}
        </ul>
      )}

      {/* Assembling a component list out of word_ids, and the free-text note, are
        * curator instruments - the same judgement as EntryReview's curator tools,
        * and hidden for the same reason. A volunteer answering "does this word
        * break into parts?" does not need a vocabulary search, and "No components
        * picked yet." above an empty picker was pure noise on a phone.
        *
        * "Already confirmed as used in" lives here too: it is provenance about
        * other words, and it rendered "No confirmed relationships yet." on
        * essentially every word. */}
      {isCurator ? (
        <div className="curator-tools">
          <button type="button" className="btn btn-secondary" aria-expanded={showTools} onClick={() => setShowTools((v) => !v)}>
            {showTools ? 'Hide curator tools' : 'Curator tools'}
          </button>
          {!showTools ? null : (
            <div aria-label="Etymology curator tools">
              <h4>Already confirmed as used in</h4>
              {review.usedAsComponentOf.length === 0 ? (
                <p>No confirmed relationships yet.</p>
              ) : (
                <ul aria-label="Confirmed used in">
                  {review.usedAsComponentOf.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              )}

              <div className="field">
                <label htmlFor="etymology-note-field">Note</label>
                <textarea id="etymology-note-field" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Only the applicable answers, and hidden rather than disabled.
        *
        * Before this, all four appeared on every word: "Accept proposed
        * components" was offered - and ENABLED - on a word with no proposal at
        * all, which submits accept_proposed over an empty list; and "Reject this
        * etymology" sat there greyed out with nothing to reject. A reviewer was
        * being asked to choose between options that, for most words, either did
        * nothing or meant nothing.
        *
        * Confirming atomic is the one answer that always applies, because it is a
        * positive claim about the word ("it has no parts") rather than a response
        * to a proposal. */}
      <h3>{hasProposal ? 'Is this breakdown right?' : 'Does this word break into parts?'}</h3>
      {!hasProposal && !hasRealExistingComponents ? (
        <p className="field-note">
          Wiktionary proposes no breakdown for this word, and none is on record. If it is a single indivisible word, say
          so - that is a real answer, not a fallback.
        </p>
      ) : null}
      <div className="btn-row">
        {hasProposal ? (
          <button type="button" className="btn btn-primary" onClick={acceptProposedComponents}>
            {label('Accept proposed components')}
          </button>
        ) : null}
        {hasRealExistingComponents ? (
          <button type="button" className="btn btn-secondary" onClick={confirmExisting}>
            {label('Confirm components')}
          </button>
        ) : null}
        <button
          type="button"
          className={`btn ${hasProposal || hasRealExistingComponents ? 'btn-secondary' : 'btn-primary'}`}
          onClick={confirmAtomic}
        >
          {label(hasProposal ? 'No, it has no parts' : 'It has no parts')}
        </button>
        {/* The other half of the question. Without this the screen could only ever
            record agreement, whatever the reviewer actually thought. */}
        {!hasProposal && !claimsHasParts ? (
          <button type="button" className="btn btn-secondary" onClick={() => setClaimsHasParts(true)}>
            It does have parts
          </button>
        ) : null}
        {hasProposal ? (
          <button type="button" className="btn btn-danger" onClick={rejectProposed}>
            {label('Reject this etymology')}
          </button>
        ) : null}
      </div>
      {claimsHasParts || (isCurator && showTools) ? (
        <div aria-label="Component picker">
          <h4>Which words is it made of?</h4>
          <p className="field-note">
            Pick the existing dictionary words that make up this one. If a part is not in the dictionary yet, ask a
            curator to add it first.
          </p>
          {draftComponents.length === 0 ? null : (
            <ul aria-label="Draft components" className="plain-list">
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
          {/* Only offered once something is actually picked - saving an empty custom
              list asserted "these are the parts" about nothing. */}
          {draftComponents.length > 0 ? (
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={saveCustomComponents}>
                {label('Save these parts')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

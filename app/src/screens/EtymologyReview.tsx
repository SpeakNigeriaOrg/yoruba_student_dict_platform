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
import type { ComponentsProposalItem, KaikkiSearchResult } from '@yoruba-student-dict-platform/shared';
import { orthographyInsensitiveForm, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import {
  createWord,
  getEtymologyReview,
  postEtymologyDecision,
  requestComponent,
  requestUnlistedWord,
  searchKaikki,
  searchVocab,
  submitEtymologyContribution,
  type ApplyEtymologyDecisionInput,
  type ComponentRequestResult,
  type EtymologyReviewResult,
} from '../api.js';
import { AxisBanner } from './AxisBanner.js';
import { PhraseComposer } from './PhraseComposer.js';
import { SearchBox } from './SearchBox.js';

// ---------------------------------------------------------------------------
// The component picker searches the whole corpus, not just our dictionary
// ---------------------------------------------------------------------------
// It used to search only `vocab-search` - our 92 words - so a volunteer who knew `adìyẹ` is
// part of `abo adìyẹ` was told to ask a curator, and could not finish the task. The knowledge
// they had went nowhere.
//
// Now both are searched and merged, words we hold first. Picking one we do not hold queues a
// request and returns the word_id it will be created under, so the etymology submission
// proceeds immediately (see api/src/handlers/resolveOrRequestComponent.ts for why the
// resolve/request decision has to be made server-side).
//
// A corpus entry is NOT hidden just because a word we hold shares its spelling. That word may
// cite a DIFFERENT etymology of that spelling, and picking between them is the whole point of
// entering words at the etymology-N level - `kọ́` returns three results here, and only one of
// them is the part the volunteer means.
type ComponentCandidate =
  | { kind: 'held'; wordId: string; displayText: string; definition: string | null }
  | {
      kind: 'corpus';
      entryId: string;
      form: string;
      pos: string;
      etymologyNumber: string | null;
      glosses: string[];
    };

async function searchComponentCandidates(query: string): Promise<ComponentCandidate[]> {
  const [held, corpus] = await Promise.all([searchVocab(query), searchKaikki(query)]);
  return [
    ...held.map(
      (r): ComponentCandidate => ({
        kind: 'held',
        wordId: r.wordId,
        displayText: r.displayText,
        definition: r.definition,
      }),
    ),
    // A null entryId predates 0014 and cannot be cited (upstreamCitations refuses it), so it
    // could only be picked to fail. Dropped rather than offered.
    ...corpus
      .filter((r): r is typeof r & { entryId: string } => r.entryId !== null)
      .map(
        (r): ComponentCandidate => ({
          kind: 'corpus',
          entryId: r.entryId,
          form: r.standardForms[0] ?? r.form,
          pos: r.pos,
          etymologyNumber: r.etymologyNumber,
          glosses: r.glosses,
        }),
      ),
  ];
}

/** What a draft component chip says. The word_id is a key, not the word - a requested one is
 * derived and deliberately never shown to the volunteer. */
interface DraftComponentLabel {
  displayText: string;
  /** Requested, not yet approved: the reference is real, the word is not there yet. */
  pending: boolean;
}

/** The part that is in neither our dictionary nor Wiktionary.
 *
 * Behind an explicit disclosure, like Add Word's own off-path branch: this is the rare case and
 * it should be chosen rather than stumbled into, because the real fix is an upstream edit and
 * this records a word that can never be checked against Wiktionary.
 *
 * No audio. This is a request for a dictionary entry, not a pronunciation - the word gets its
 * audio axis like any other once a curator approves it.
 *
 * The composer is the same one the example axis uses (PhraseComposer): the underdotted letters
 * as tap keys, tone on a grid that GENERATES the marks. That is what makes a correctly-written
 * request possible from a phone with no Yoruba keyboard, and it is why the composer took an `id`
 * prop - two of them on one screen would otherwise collide. */
function RequestUnlistedWord({ onRequested }: { onRequested: (result: ComponentRequestResult) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [displayText, setDisplayText] = useState('');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ready = displayText.trim() !== '' && definition.trim() !== '';

  async function submit() {
    setError(null);
    try {
      onRequested(await requestUnlistedWord(displayText.trim(), definition.trim()));
      setDisplayText('');
      setDefinition('');
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!expanded) {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setExpanded(true)}>
        It isn't in Wiktionary either
      </button>
    );
  }

  return (
    <div className="warning-banner" aria-label="Request a word with no Wiktionary entry">
      <p>
        <strong>This word has no Wiktionary entry.</strong> The preferred route is to ask a curator to add it to
        Wiktionary first, then come back and cite it - a cited word can be checked against upstream forever, and this one
        cannot. Use this only when you are sure it is missing.
      </p>
      <PhraseComposer
        id="unlisted-word"
        value={displayText}
        onChange={setDisplayText}
        label="The word, written correctly"
        placeholder="e.g. adìyẹ"
      />
      <div className="field">
        <label htmlFor="unlisted-word-definition">What does it mean in English?</label>
        <input
          id="unlisted-word-definition"
          type="text"
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
        />
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="btn-row">
        {/* Hidden until both are filled would hide the action itself; disabled is right here
            because the missing half is visible in the field right above it. */}
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!ready}>
          Request this word
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setExpanded(false);
            setDisplayText('');
            setDefinition('');
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

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
      {/* Said in the reader's terms. `→ resolves to <word_id>` and `not in golden_record yet` were
          both written for whoever was debugging the resolver: one shows a key this screen's own
          rule says never to show, the other names a database table. */}
      {item.wordId ? (
        <span> — already in the dictionary</span>
      ) : item.ambiguous ? (
        <span> — more than one word in the dictionary is spelled this way, so which one is meant is unclear</span>
      ) : item.possibleMatches.length > 0 ? (
        <span> — the dictionary has this spelling with different tone marks, which may or may not be the same word</span>
      ) : (
        <span> — not in the dictionary yet</span>
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
          // Was "Ask a curator to add this word before it can be linked as a part" - true at the
          // time and a dead end regardless. The picker below now finds it in Wiktionary and
          // requests it, so the volunteer finishes the task and the curator gets the request.
          <p className="field-note">Not in the dictionary yet - add it from the picker below and it will be requested.</p>
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
  const [draftLabels, setDraftLabels] = useState<Record<string, DraftComponentLabel>>({});
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
    setDraftLabels({});
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
      `Saved these parts: ${draftComponents.map((id) => draftLabels[id]?.displayText ?? id).join(', ')}`,
    );
  }

  function addDraftComponent(componentWordId: string, label: DraftComponentLabel) {
    setDraftComponents((prev) => (prev.includes(componentWordId) ? prev : [...prev, componentWordId]));
    setDraftLabels((prev) => ({ ...prev, [componentWordId]: label }));
  }

  /** Opens the picker with the parts that DID resolve already in the draft, so a volunteer
   * fixing a partly-unresolvable proposal only has to supply what is missing rather than
   * rebuilding the whole list by hand. */
  function openPickerFromProposal() {
    for (const item of review?.componentsProposal ?? []) {
      if (item.wordId) addDraftComponent(item.wordId, { displayText: item.kaikkiForm, pending: false });
    }
    setClaimsHasParts(true);
  }

  /** Both request paths land here: the returned word_id goes straight into the draft, whether
   * the word already existed or a curator has yet to approve it. */
  function acceptRequestResult(result: ComponentRequestResult) {
    addDraftComponent(result.wordId, {
      displayText: result.displayText,
      pending: result.outcome !== 'resolved',
    });
    setStatus(
      result.outcome === 'resolved'
        ? null
        : `"${result.displayText}" is not in the dictionary yet, so it has been requested. Your answer here is recorded now - the link completes when a curator adds it.`,
    );
  }

  async function pickCandidate(candidate: ComponentCandidate) {
    if (candidate.kind === 'held') {
      addDraftComponent(candidate.wordId, { displayText: candidate.displayText, pending: false });
      return;
    }
    // Only the server can tell whether this etymology is one we already hold. It answers with
    // the word_id either way, so the submission below never waits on a curator.
    try {
      acceptRequestResult(await requestComponent(candidate.entryId));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function removeManualComponent(componentWordId: string) {
    setDraftComponents((prev) => prev.filter((id) => id !== componentWordId));
  }

  const isPhrase = review?.entryType === 'phrase';
  const hasRealExistingComponents =
    review !== null && review.components.length > 0 && !(review.components.length === 1 && review.components[0] === wordId);
  /** A one-part "breakdown" is not a breakdown.
   *
   * 9 of the 21 words in the dictionary that have any proposal at all have exactly one candidate -
   * `ọba → ba`, `ẹwà → wà`, `ọgbọ́n → gbọ́n`. Accepting one asserts that a word is composed of ONE
   * word, which is a morphological derivation (a prefix on a verb root), not a decomposition into
   * dictionary entries. Wiktionary's own prose says that better, and it is already on screen below.
   *
   * So it is not offered as a breakdown to accept - the same rule this screen already applies to
   * "accept" with nothing to accept and "reject" with nothing to reject. */
  const hasProposal = (review?.componentsProposal.length ?? 0) > 1;
  const singleRootProposal = review?.componentsProposal.length === 1 ? review.componentsProposal[0] : null;
  /** Parts Wiktionary names that we hold no word for. `abo adìyẹ` is the live example: `adìyẹ`
   * was not in the dictionary, so "Accept proposed components" could only ever answer "Can't
   * accept yet" - the accept path submits word_ids, and one of them did not exist. Offering an
   * answer that cannot be given is the same defect as the enabled-with-nothing-to-accept button
   * this file already fixed once, so the unresolvable case gets the picker instead. */
  const unresolvedProposalForms = (review?.componentsProposal ?? []).filter((p) => !p.wordId).map((p) => p.kaikkiForm);
  const proposalFullyResolves = hasProposal && unresolvedProposalForms.length === 0;
  /** Drafted words that a curator still has to approve. Reported, never blocking. */
  const pendingPhraseWordCount = draftComponents.filter((id) => draftLabels[id]?.pending).length;

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

      {/* What the reader is here to do, said once, with a real example from this dictionary.
        *
        * `ibùsùn` is the right example precisely because both of its parts are ambiguous: `ibi` is
        * also "placenta" and "evil", `sùn` is also "to aim" and "to complain". So it teaches the
        * concept AND the rule that a part is one specific meaning rather than a spelling - which is
        * the whole reason this axis exists and was previously argued only in a code comment.
        *
        * AddWord has the equivalent sentence for its own act ("A word enters the dictionary as one
        * Wiktionary etymology..."); this axis had none. */}
      <div className="field-note" aria-label="What this task is">
        {isPhrase ? (
          <p>
            A phrase is made of words, and each word is one <em>specific</em> meaning. In{' '}
            <strong>ibùsùn</strong> (bed) the parts are <strong>ibi</strong> (place) and <strong>sùn</strong> (sleep) —
            but <strong>ibi</strong> can also mean "placenta" or "evil", so naming the part means naming <em>which</em>{' '}
            one. Link each word of this phrase to the meaning it has here.
          </p>
        ) : (
          <p>
            Some Yoruba words are built from other words. <strong>ibùsùn</strong> (bed) is{' '}
            <strong>ibi</strong> (place) + <strong>sùn</strong> (sleep) — recording that lets a learner find words they
            already know inside a longer one. Note that <strong>ibi</strong> also means "placenta" and "evil": a part is
            one <em>specific</em> meaning, not just a spelling.
          </p>
        )}
      </div>

      {isPhrase ? null : (
        <>
          <h3>What Wiktionary suggests this is built from</h3>
          {review.componentsProposal.length === 0 ? (
            <p>Wiktionary suggests no breakdown for this word.</p>
          ) : (
            <ul aria-label="Proposed components">
              {review.componentsProposal.map((item, i) => (
                <ProposalItemRow key={i} item={item} onAdded={refreshAfterAddingComponent} isCurator={isCurator} />
              ))}
            </ul>
          )}
          {/* Shown, but not as something to accept - see hasProposal. */}
          {singleRootProposal ? (
            <p className="field-note" aria-label="Single root note">
              Wiktionary derives this word from <strong>{singleRootProposal.kaikkiForm}</strong> alone. That is where it
              comes from historically, not a breakdown into parts — a word is not made <em>of</em> one word — so there is
              nothing to accept here. If it really does break into two or more words, say so below.
            </p>
          ) : null}
        </>
      )}

      {review.etymologyText && !isPhrase ? (
        <div aria-label="Kaikki etymology note">
          <p>Wiktionary also describes where this word comes from, in prose:</p>
          <p><em>{review.etymologyText}</em></p>
        </div>
      ) : null}

      {/* The "Used in (other words that use this one as a component)" section stood here, with the
          curator-only "Already confirmed as used in" below it. Both are gone.

          Nothing on this screen could ever act on them: applyEtymologyDecision writes component
          rows only for the word under review, so no button here could move an item from
          usedInProposal into usedAsComponentOf - that happens when the OTHER word's etymology axis
          is decided. It was decoration on 47 of 80 cited words, and once the request flow landed it
          became actively wrong, because ProposalItemRow is shared: a "Used in" row told the reader
          to "add it from the picker below", and that picker adds parts OF this word. Following it
          recorded the inverse relationship.

          Derived terms are the example axis's subject, and it teaches them properly there ("A
          phrase built from this one: adìyẹ → abo adìyẹ"). The response no longer carries either
          field - see getEtymologyReview.ts. */}

      {/* Assembling a component list out of word_ids, and the free-text note, are
        * curator instruments - the same judgement as EntryReview's curator tools,
        * and hidden for the same reason. A volunteer answering "does this word
        * break into parts?" does not need a vocabulary search, and "No components
        * picked yet." above an empty picker was pure noise on a phone.
        *
        * "Already confirmed as used in" used to live here too and is gone with the rest of the
        * reverse direction - see the note above. */}
      {isCurator ? (
        <div className="curator-tools">
          <button type="button" className="btn btn-secondary" aria-expanded={showTools} onClick={() => setShowTools((v) => !v)}>
            {showTools ? 'Hide curator tools' : 'Curator tools'}
          </button>
          {!showTools ? null : (
            <div aria-label="Etymology curator tools">
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
      <h3>
        {isPhrase
          ? 'Which words is this phrase made of?'
          : hasProposal
            ? 'Is this breakdown right?'
            : 'Does this word break into parts?'}
      </h3>
      {/* A phrase is never asked whether it has parts. Its identity IS its constituent words - that
          is literally what its citation exemption says - so "It has no parts" and "Reject this
          etymology" are not available answers about one, and it was being offered both. */}
      {isPhrase && !hasRealExistingComponents ? (
        <p className="field-note" aria-label="Phrase with no words linked">
          No words are linked to this phrase yet. Add one for each word of <strong>{review.displayText}</strong>.
        </p>
      ) : null}
      {!isPhrase && !hasProposal && !hasRealExistingComponents ? (
        <p className="field-note">
          Wiktionary proposes no breakdown for this word, and none is on record. If it is a single indivisible word, say
          so - that is a real answer, not a fallback.
        </p>
      ) : null}
      {hasProposal && !proposalFullyResolves ? (
        <p className="field-note" aria-label="Parts not in the dictionary">
          {unresolvedProposalForms.length === 1 ? 'One part of this breakdown' : 'Some parts of this breakdown'} (
          <strong>{unresolvedProposalForms.join(', ')}</strong>) {unresolvedProposalForms.length === 1 ? 'is' : 'are'} not
          in the dictionary yet, so the breakdown can't be accepted as it stands. Build the list below - you can add a
          missing part straight from Wiktionary.
        </p>
      ) : null}
      <div className="btn-row">
        {proposalFullyResolves ? (
          <button type="button" className="btn btn-primary" onClick={acceptProposedComponents}>
            {label('Accept proposed components')}
          </button>
        ) : null}
        {hasProposal && !proposalFullyResolves && !claimsHasParts ? (
          <button type="button" className="btn btn-primary" onClick={openPickerFromProposal}>
            Build the list of parts
          </button>
        ) : null}
        {hasRealExistingComponents ? (
          <button type="button" className="btn btn-secondary" onClick={confirmExisting}>
            {label('Confirm components')}
          </button>
        ) : null}
        {isPhrase ? null : (
          <button
            type="button"
            className={`btn ${hasProposal || hasRealExistingComponents ? 'btn-secondary' : 'btn-primary'}`}
            onClick={confirmAtomic}
          >
            {label(hasProposal ? 'No, it has no parts' : 'It has no parts')}
          </button>
        )}
        {/* The other half of the question. Without this the screen could only ever
            record agreement, whatever the reviewer actually thought.
            For a phrase the picker is the task itself, so it opens without being asked for. */}
        {!isPhrase && !hasProposal && !claimsHasParts ? (
          <button type="button" className="btn btn-secondary" onClick={() => setClaimsHasParts(true)}>
            It does have parts
          </button>
        ) : null}
        {hasProposal && !isPhrase ? (
          <button type="button" className="btn btn-danger" onClick={rejectProposed}>
            {label('Reject this etymology')}
          </button>
        ) : null}
      </div>
      {isPhrase || claimsHasParts || (isCurator && showTools) ? (
        <div aria-label="Component picker">
          <h4>{isPhrase ? 'The words of this phrase, in order' : 'Which words is it made of?'}</h4>
          <p className="field-note">
            {isPhrase ? (
              <>
                One entry per word of <strong>{review.displayText}</strong>, in the order they are said. Words already in
                the dictionary come first; anything below them comes from Wiktionary, and picking it asks a curator to add
                it. Either way you can finish here now.
              </>
            ) : (
              <>
                Search for each part. Words already in the dictionary come first; anything below them comes from
                Wiktionary, and picking it asks a curator to add it. Either way you can finish here now.
              </>
            )}
          </p>
          {/* Named and counted, but NOT a gate - the locked decision. A phrase whose words are only
              requested is still a better record than one with nothing linked, and the volunteer who
              knew the words should not be held until a curator acts. */}
          {isPhrase && pendingPhraseWordCount > 0 ? (
            <p className="field-note" aria-label="Words awaiting approval">
              {pendingPhraseWordCount === 1
                ? '1 of these words is not in the dictionary yet and has been requested.'
                : `${pendingPhraseWordCount} of these words are not in the dictionary yet and have been requested.`}{' '}
              You can still save — the links complete when a curator adds them.
            </p>
          ) : null}
          {draftComponents.length === 0 ? null : (
            <ul aria-label="Draft components" className="plain-list">
              {draftComponents.map((componentWordId) => {
                const drafted = draftLabels[componentWordId];
                return (
                  <li key={componentWordId} className="search-result-row">
                    {/* The word, not its word_id. A requested word's id is derived and
                        deliberately never shown - it is a key, and showing it would invite
                        someone to ask for a different one, which is exactly what would break
                        agreement between two volunteers naming the same part. Falls back to the
                        id for components already on record, where that is all we know. */}
                    <span className="result-text">
                      {drafted?.displayText ?? componentWordId}
                      {drafted?.pending ? <em> — will be added once a curator approves</em> : null}
                    </span>
                    <button type="button" className="btn btn-danger" onClick={() => removeManualComponent(componentWordId)}>
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <SearchBox
            search={searchComponentCandidates}
            initialQuery={unresolvedProposalForms[0]}
            renderResult={(r) =>
              r.kind === 'held' ? (
                <>
                  <strong>{r.displayText}</strong> — in the dictionary
                  {r.definition ? ` (${r.definition})` : ''}
                </>
              ) : (
                <>
                  <strong>{r.form}</strong> — from Wiktionary ({r.pos}
                  {r.etymologyNumber ? `, etymology ${r.etymologyNumber}` : ''}) - {r.glosses.join('; ')}
                </>
              )
            }
            onSelect={pickCandidate}
            selectLabel="Add"
            placeholder="Search for a part..."
            resultsAriaLabel="Component search results"
          />
          <div className="btn-row">
            <RequestUnlistedWord onRequested={acceptRequestResult} />
          </div>
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

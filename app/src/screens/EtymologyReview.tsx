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
import type { KaikkiSearchResult } from '@yoruba-student-dict-platform/shared';
import { orthographyInsensitiveForm, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import {
  createWord,
  getEtymologyReview,
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

/** What a reviewer picked for one proposed part: a word we hold, or one just requested. */
export interface ChosenPart {
  wordId: string;
  displayText: string;
  pending: boolean;
}

function ProposalItemRow({
  item,
  onAdded,
  isCurator,
  chosen,
  onChoose,
}: {
  item: EtymologyReviewResult['componentsProposal'][number];
  onAdded: (wordId: string) => void;
  isCurator: boolean;
  chosen?: ChosenPart;
  onChoose: (part: ChosenPart) => void;
}) {
  const candidates = item.wiktionaryCandidates ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // With Wiktionary's own candidates to pick from, the old "add it from the picker below" route is
  // not needed - the candidate list IS the route.
  const notInVocabYet = !item.wordId && !item.ambiguous && item.possibleMatches.length === 0 && candidates.length === 0;

  /** One tap: requestComponent resolves to the word we hold for that etymology, or queues a
   * request for it (see api/src/handlers/resolveOrRequestComponent.ts) - either way the part is
   * settled on this screen and the answer can be submitted now. */
  async function choose(entryId: string) {
    setBusy(entryId);
    setError(null);
    try {
      const r = await requestComponent(entryId);
      onChoose({ wordId: r.wordId, displayText: r.displayText, pending: r.outcome !== 'resolved' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

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
        // Our dictionary holds this spelling only with other tone marks. Named, because an unnamed
        // near-miss ("the dictionary has this spelling with different tone marks...") read as a
        // claim about Wiktionary and gave nothing to check it against.
        <span>
          {' '}
          — not in the dictionary; we have{' '}
          {(item.possibleMatchWords ?? []).map((w, i) => (
            <span key={w.wordId}>
              {i > 0 ? ', ' : ''}
              <strong>{w.displayText}</strong>
              {w.definition ? ` (${w.definition})` : ''}
            </span>
          ))}
        </span>
      ) : (
        <span> — not in the dictionary yet</span>
      )}
      {/* The merged preview of every sense of the spelling is replaced by the candidate list below
          when there is one - one parenthesis of "to dream; to lick; to cut" was the reader's only
          clue to which là was meant. */}
      {candidates.length > 0 ? null : item.previewGlosses.length > 0 ? (
        <span> ({item.previewGlosses.join('; ')})</span>
      ) : item.resolvedDefinition ? (
        // The matched word's own definition, not a Kaikki gloss - see resolvedDefinition's own
        // note. This is what tells a reader which of a homograph's meanings this actually is,
        // e.g. which "sùn" (sleep / aim / complain) ibùsùn is built from.
        <span> ({item.resolvedDefinition})</span>
      ) : null}
      {/* Adding the missing word posts to POST /api/words, which is curator-only
          both in staticwebapp.config.json and in the handler's own requireCurator.
          Offering it to a volunteer produced a live "403" at the end of a filled-in
          form - the same shape of defect as the /api/contributions route-ordering
          403: a member-facing control wired to a curator-only endpoint. A
          volunteer is told what to do instead. */}
      {chosen ? (
        <p className="field-note" aria-label="Chosen part">
          Using <strong>{chosen.displayText}</strong>
          {chosen.pending ? ' - requested; a curator will add it' : ''}.
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <div aria-label={`Wiktionary candidates for ${item.kaikkiForm}`}>
          {item.wiktionaryGloss ? (
            <p className="field-note">
              Wiktionary&apos;s etymology means: <em>{item.wiktionaryGloss}</em>
            </p>
          ) : null}
          <ul className="plain-list">
            {candidates.map((c, i) => (
              <li key={c.entryId}>
                <strong>{c.form}</strong> ({c.pos}
                {c.etymologyNumber ? `, etymology ${c.etymologyNumber}` : ''}) - {c.glosses.join('; ') || '(no gloss)'}
                {i === 0 && item.wiktionaryGloss && candidates.length > 1 ? (
                  <span className="badge decided"> best match</span>
                ) : null}
                {c.held ? <span className="field-note"> - in the dictionary</span> : null}{' '}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy !== null}
                  onClick={() => choose(c.entryId)}
                  aria-label={`Use ${c.form}: ${c.glosses[0] ?? c.pos}`}
                >
                  {busy === c.entryId ? 'Working...' : c.held ? 'Use this' : 'Use this (request it)'}
                </button>
              </li>
            ))}
          </ul>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
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
  /** Opened deliberately, by its own button. See the note where the picker is rendered. */
  const [showCustomComponents, setShowCustomComponents] = useState(false);
  /** The disagree branch. "It has no parts" is a complete answer on its own; saying it
   * DOES have parts is only half an answer, so it reveals the picker rather than
   * submitting. Available to volunteers - it was curator-only, which is precisely what
   * left the screen with a single clickable answer. */
  const [claimsHasParts, setClaimsHasParts] = useState(false);
  const [answerRecorded, setAnswerRecorded] = useState(false);
  const [selectedCandidateWordIds, setSelectedCandidateWordIds] = useState<Record<string, string>>({});
  /** Per proposed part (by position), the Wiktionary etymology the reviewer picked for it. Wins
   * over the spelling-based match: that one only knows the spelling, and là is five words. */
  const [chosenParts, setChosenParts] = useState<Record<number, ChosenPart>>({});
  /** Closed by default on an already-settled word - see decidedAndSettled below. Opened
   * deliberately, the same pattern as showCustomComponents, so reconsidering is always one
   * click away rather than gone. */
  const [showReconsider, setShowReconsider] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setDraftComponents([]);
    setDraftLabels({});
    setShowTools(false);
    setClaimsHasParts(false);
    setAnswerRecorded(false);
    setSelectedCandidateWordIds({});
    setChosenParts({});
    setShowReconsider(false);
    getEtymologyReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        // componentsOnRecord has the atomic self-reference already collapsed server-side, so the
        // `[wordId]` test that used to live here is gone from the client entirely - it was stated
        // in two places and is now stated in one. Seeding the labels too, so a list loaded from the
        // record shows its words instead of falling back to printing word_ids.
        setDraftComponents(result.componentsOnRecord.map((c) => c.wordId));
        setDraftLabels(
          Object.fromEntries(result.componentsOnRecord.map((c) => [c.wordId, { displayText: c.displayText, pending: false }])),
        );
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
      // Everyone contributes, curators included - and this axis is the clearest case for it.
      // A curator's grasp of a word's parts is not better than a volunteer's; it is one more
      // reading of the same evidence, which is exactly what the consensus tally is for.
      await submitEtymologyContribution(wordId, input);
      setAnswerRecorded(true);
      setStatus(`Recorded as your answer: ${successMessage}`);
      onDecided?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function acceptProposedComponents() {
    if (!review) return;
    const resolvedIds = partIds.filter((id): id is string => id !== null);
    if (resolvedIds.length !== review.componentsProposal.length) {
      setStatus("Can't accept yet - some proposed components don't resolve to a confirmed word_id.");
      return;
    }
    await submit({ componentsAction: 'accept_proposed', components: resolvedIds, note: note || undefined }, 'Accepted proposed components.');
  }

  /** A partial etymology: the parts that resolve, in order, leaving out the ones we hold no word for
   * yet. ìlà → là is worth recording while ì- is still missing. Recorded as 'custom' because it is
   * not Wiktionary's breakdown as proposed - it is the part of it that can be said today. */
  async function acceptResolvedParts() {
    const ids = partIds.filter((id): id is string => id !== null);
    if (ids.length === 0) return;
    await submit(
      { componentsAction: 'custom', components: ids, note: note || undefined },
      `Recorded the parts we have: ${ids.map((id) => partLabel(id)).join(' + ')}`,
    );
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
    setAnswerRecorded(false);
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
      setSelectedCandidateWordIds((selected) => ({ ...selected, [`held:${candidate.wordId}`]: candidate.wordId }));
      return;
    }
    // Only the server can tell whether this etymology is one we already hold. It answers with
    // the word_id either way, so the submission below never waits on a curator.
    try {
      const result = await requestComponent(candidate.entryId);
      acceptRequestResult(result);
      setSelectedCandidateWordIds((selected) => ({ ...selected, [`corpus:${candidate.entryId}`]: result.wordId }));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  /** By position, not by word_id - removeManualComponent used to filter every occurrence of the
   * id out at once, which was invisible until duplicateDraftComponent existed to create a second
   * one: removing ONE méjì out of méjì méjì removed both. */
  function removeManualComponent(index: number) {
    const removedWordId = draftComponents[index];
    setAnswerRecorded(false);
    setDraftComponents((prev) => prev.filter((_, i) => i !== index));
    // Only clear the "already added" mark on the search result once no other occurrence of this
    // word remains in the draft - removing one copy of a reduplicated word does not mean the word
    // stopped being used here, and re-enabling the result mid-edit would invite a second
    // *accidental* copy right after removing a deliberate one.
    if (!draftComponents.some((id, i) => id === removedWordId && i !== index)) {
      setSelectedCandidateWordIds((selected) =>
        Object.fromEntries(Object.entries(selected).filter(([, wordId]) => wordId !== removedWordId)),
      );
    }
  }

  /** The escape hatch for reduplication (méjì méjì, mẹ́ta mẹ́ta...), which is common and
   * legitimate in Yoruba. addDraftComponent still refuses a second pick of the same word from
   * search - that refusal is what catches an ACCIDENTAL double-click, and is worth keeping - so
   * an intentional repeat is asked for explicitly, right next to the copy it repeats, rather than
   * by changing what the search results do. Inserted right after its source rather than appended,
   * so the pair reads together instead of the copy having to be walked back into place. */
  function duplicateDraftComponent(index: number) {
    setAnswerRecorded(false);
    setDraftComponents((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, prev[index]);
      return next;
    });
  }

  /** Swaps the draft component at `index` with its neighbor in `direction`. Order here is
   * saved as component_position - the primary key alongside word_id - so getting it wrong is
   * not cosmetic, and picking happens in whatever order a search turns candidates up rather
   * than in the order they belong. */
  function moveDraftComponent(index: number, direction: -1 | 1) {
    setAnswerRecorded(false);
    setDraftComponents((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const isPhrase = review?.entryType === 'phrase';
  /** Our own breakdown, already resolved and already free of the atomic self-reference - the server
   * collapses it now, so this is a plain "is there one?" rather than the two-clause test that used
   * to be repeated here and in the loader. */
  const onRecord = review?.componentsOnRecord ?? [];
  const hasRealExistingComponents = onRecord.length > 0;
  /** Wiktionary's breakdown, in word_ids, where every part resolves to a word we hold. Null when it
   * proposes nothing comparable - either no proposal, or one naming parts we do not have, which is
   * an unresolved suggestion rather than a rival answer. */
  const proposalIds =
    (review?.componentsProposal.length ?? 0) > 1 && (review?.componentsProposal ?? []).every((p) => p.wordId)
      ? (review?.componentsProposal ?? []).map((p) => p.wordId as string)
      : null;
  /** Two answers to one question, and they differ.
   *
   * Order counts: a decomposition is a sequence, and `ojú + ilé` is not `ilé + ojú`. Only computed
   * when we actually hold a breakdown - with nothing of our own on record, Wiktionary's suggestion
   * is not in disagreement with anything, it is just the only answer available. */
  const sourcesDisagree =
    hasRealExistingComponents &&
    proposalIds !== null &&
    (proposalIds.length !== onRecord.length || proposalIds.some((id, i) => id !== onRecord[i].wordId));
  /** Any proposal is offered, including a one-part one.
   *
   * A one-part proposal (`ìlà → là`, `ọba → ba`) is usually a PARTIAL etymology: Wiktionary says
   * `ì- + là`, and ingest drops the prefix because a bound morpheme is not a dictionary word. This
   * screen used to refuse those ("a word is not made of one word"), which threw away exactly the
   * link worth recording - ìlà comes from là - and discouraged recording partial etymologies at
   * all. Wiktionary's prose, shown below, carries the rest. */
  const hasProposal = (review?.componentsProposal.length ?? 0) > 0;
  /** Parts Wiktionary names that we hold no word for. `abo adìyẹ` is the live example: `adìyẹ`
   * was not in the dictionary, so "Accept proposed components" could only ever answer "Can't
   * accept yet" - the accept path submits word_ids, and one of them did not exist. Offering an
   * answer that cannot be given is the same defect as the enabled-with-nothing-to-accept button
   * this file already fixed once, so the unresolvable case gets the picker instead. */
  /** Each proposed part's word_id: the reviewer's pick when they made one, else the spelling match. */
  const partIds = (review?.componentsProposal ?? []).map((p, i) => chosenParts[i]?.wordId ?? p.wordId);
  const partLabel = (id: string) =>
    Object.values(chosenParts).find((c) => c.wordId === id)?.displayText ??
    review?.componentsProposal.find((p) => p.wordId === id)?.kaikkiForm ??
    id;
  const unresolvedProposalForms = (review?.componentsProposal ?? [])
    .filter((_, i) => !partIds[i])
    .map((p) => p.kaikkiForm);
  const proposalFullyResolves = hasProposal && unresolvedProposalForms.length === 0;
  /** Some parts resolve and some do not - the partial etymology case (ìlà: là yes, ì- not yet). */
  const someProposalPartsResolve = hasProposal && !proposalFullyResolves && partIds.some((id) => id !== null);
  /** Drafted words that a curator still has to approve. Reported, never blocking. */
  const pendingPhraseWordCount = draftComponents.filter((id) => draftLabels[id]?.pending).length;
  /** Nothing left to re-litigate on a first look: a curator already decided this axis, what they
   * decided matches what's on record (checked above, in "What we have on record"), and Wiktionary
   * does not currently contradict it. This is the exact case that read as "did this even save?" -
   * the record was shown once, correctly, and then immediately followed by a full "Is this
   * breakdown right?" review UI at the same visual weight as a word nobody has ever looked at.
   * Collapsing it behind `showReconsider` does not hide anything permanently; reconsidering upstream
   * is still one click away, just not the first thing on screen for a word already settled.
   * Excludes sourcesDisagree on purpose - a decided word that upstream now contradicts is worth
   * surfacing, not hiding. Phrases are unaffected: they have no separate proposal-comparison UI to
   * collapse in the first place. */
  const decidedAndSettled = !isPhrase && hasRealExistingComponents && review?.axisDecided.etymology === true && !sourcesDisagree;

  if (error) return <p role="alert" className="error-banner">Couldn't load etymology data: {error}</p>;
  if (!review) return <p>Loading etymology data...</p>;

  // One wording for everyone. It used to be the volunteer who got the explicit "Propose:"
  // while the curator got the bare verb - the person writing fact had the vaguer label.
  const label = (text: string) => text;
  /** The word as this reviewer has said it is - see api/src/myEntryAnswer.ts. */
  const shownDisplayText = review.myProposedEntry?.spellingChanged ? review.myProposedEntry.displayText : review.displayText;

  return (
    <section aria-label="Etymology review" className={`card${review.axisDecided.etymology ? ' decided' : ''}`}>
      <AxisBanner
        displayText={review.displayText}
        syllables={review.syllables}
        definition={review.definition}
        axisDecided={review.axisDecided}
        currentAxis="Etymology"
        mine={review.myProposedEntry}
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

      {/* Ours first, because it is the record and Wiktionary's is a suggestion about it. This
          section did not exist: a word whose breakdown we already held showed only the upstream
          proposal, so a curator who had just entered the parts on Add Word came here, read
          "Wiktionary suggests no breakdown for this word", and reasonably concluded nothing had
          saved. The list was on screen nowhere unless you clicked "It does have parts" - i.e. you
          had to claim the word has parts to discover it was already recorded as having them. */}
      {hasRealExistingComponents ? (
        <div aria-label="Components on record">
          <h3>{isPhrase ? 'The words of this phrase, as recorded' : 'What we have on record'}</h3>
          <ul aria-label="Recorded components" className="plain-list">
            {onRecord.map((c, i) => (
              // Keyed by position: a reduplication holds one word twice, and the position is what
              // tells the two apart.
              <li key={`${i}-${c.wordId}`}>
                <strong>{c.displayText}</strong>
                {/* The spelling alone does not say which word this is - sùn is at least three
                    things (sleep, aim, complain), and one of those three is what was actually
                    confirmed here. Same reasoning as componentsProposal.resolvedDefinition. */}
                {c.definition ? ` — ${c.definition}` : ''}
              </li>
            ))}
          </ul>
          <p className="field-note">
            {review.axisDecided.etymology
              ? 'Confirmed on this word\u2019s etymology axis.'
              : 'Recorded when this entry was added, and not yet confirmed here - that is what this screen is for.'}
          </p>
        </div>
      ) : null}

      {/* The reconsider toggle. Shown only in place of the section it opens - both never appear
          at once, so there is never a moment where the record above and a fully-open "is this
          right?" review sit on screen together implying the record might not have stuck. */}
      {decidedAndSettled && !showReconsider ? (
        <p className="field-note">
          <button type="button" className="btn btn-secondary" onClick={() => setShowReconsider(true)}>
            Compare against Wiktionary&apos;s proposal
          </button>
        </p>
      ) : null}

      {isPhrase || (decidedAndSettled && !showReconsider) ? null : (
        <>
          <h3>{hasRealExistingComponents ? 'What Wiktionary suggests instead' : 'What Wiktionary suggests this is built from'}</h3>
          {review.componentsProposal.length === 0 ? (
            <p>Wiktionary suggests no breakdown for this word.</p>
          ) : (
            <ul aria-label="Proposed components">
              {review.componentsProposal.map((item, i) => (
                <ProposalItemRow
                  key={i}
                  item={item}
                  onAdded={refreshAfterAddingComponent}
                  isCurator={isCurator}
                  chosen={chosenParts[i]}
                  onChoose={(part) => {
                    setAnswerRecorded(false);
                    setChosenParts((prev) => ({ ...prev, [i]: part }));
                  }}
                />
              ))}
            </ul>
          )}
          {/* Named rather than left for the reader to diff two lists by eye. Both answers stay on
              screen and both actions stay available: upstream is often right and occasionally
              wrong, and nothing in the data says which - the same reason the phrase screen reports
              a spelling that differs from its parts instead of refusing it. */}
          {sourcesDisagree ? (
            <div role="alert" aria-label="Sources disagree" className="warning-banner">
              <p>
                <strong>This does not match what we hold.</strong> We record{' '}
                <strong>{onRecord.map((c) => c.displayText).join(' + ')}</strong>; Wiktionary proposes{' '}
                <strong>{review.componentsProposal.map((p) => p.kaikkiForm).join(' + ')}</strong>.
              </p>
              <p className="field-note">
                Confirm ours if the record is right, accept Wiktionary&apos;s if it is better, or build the list
                yourself. Nothing is changed until you choose.
              </p>
            </div>
          ) : null}
        </>
      )}

      {review.etymologyText && !isPhrase && !(decidedAndSettled && !showReconsider) ? (
        <div aria-label="Kaikki etymology note">
          <p>Wiktionary&apos;s etymology:</p>
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
      {/* The note is for everyone now.
        *
        * It lived inside a panel only curators could open, so a volunteer's contribution
        * could never carry one - although the endpoint has always accepted it, and the
        * person most likely to want to explain their reasoning is the one least sure of it. */}
      <div className="curator-tools">
        <button type="button" className="btn btn-secondary" aria-expanded={showTools} onClick={() => setShowTools((v) => !v)}>
          {showTools ? 'Hide note' : 'Add a note'}
        </button>
        {!showTools ? null : (
          <div aria-label="Etymology note">
            <div className="field">
              <label htmlFor="etymology-note-field">Note</label>
              <textarea id="etymology-note-field" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              <p className="field-note">Why you answered this way. Kept with your answer.</p>
            </div>
          </div>
        )}
      </div>

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
      {decidedAndSettled && !showReconsider ? null : (
        <>
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
          No words are linked to this phrase yet. Add one for each word of <strong>{shownDisplayText}</strong>.
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
          {/* Not "is not in the dictionary yet" - that is only ONE of the three reasons a part can
              fail to resolve (see ProposalItemRow above: missing, ambiguous, or tone-mismatched),
              and stating it unconditionally was flatly wrong for the other two - an ambiguous part
              (more than one existing word spelled that way) IS in the dictionary; which one is
              meant is what's unresolved. Points back at the per-item reason instead of re-asserting
              a specific one that may not apply. */}
          <strong>{unresolvedProposalForms.join(', ')}</strong> {unresolvedProposalForms.length === 1 ? "isn't" : "aren't"} settled
          yet. Pick {unresolvedProposalForms.length === 1 ? 'it' : 'them'} from Wiktionary above
          {someProposalPartsResolve ? ', record the parts we have,' : ''} or build the list yourself.
        </p>
      ) : null}
      <div className="btn-row">
        {/* Secondary once we hold a breakdown of our own. Our record is the thing under review and
            upstream's is the alternative to it, so "Confirm components" is the primary action and
            this is the deliberate departure from it - the two used to be the other way round, which
            offered a curator Wiktionary's answer first about a word we had already answered. */}
        {proposalFullyResolves ? (
          <button
            type="button"
            className={`btn ${hasRealExistingComponents ? 'btn-secondary' : 'btn-primary'}`}
            onClick={acceptProposedComponents}
          >
            {label('Accept proposed components')}
          </button>
        ) : null}
        {someProposalPartsResolve ? (
          <button type="button" className="btn btn-primary" onClick={acceptResolvedParts}>
            Accept the parts we have ({partIds.filter((id): id is string => id !== null).map(partLabel).join(' + ')})
          </button>
        ) : null}
        {hasProposal && !proposalFullyResolves && !claimsHasParts ? (
          <button
            type="button"
            className={`btn ${someProposalPartsResolve ? 'btn-secondary' : 'btn-primary'}`}
            onClick={openPickerFromProposal}
          >
            Build the list of parts
          </button>
        ) : null}
        {hasRealExistingComponents ? (
          <button type="button" className="btn btn-primary" onClick={confirmExisting}>
            {label(sourcesDisagree ? 'Confirm ours' : 'Confirm components')}
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
        </>
      )}
      {/* No longer opened as a side effect of the notes panel.
        *
        * `isCurator && showTools` used to be a third way in here, so expanding a panel
        * advertised as a Note box also rendered this picker below the fold - and its Save
        * button wrote golden_record. The panel said nothing about that. It writes a
        * contribution now, which is less dangerous, but a control appearing because you
        * opened something else is still a control nobody chose to open. */}
      {!isPhrase && !claimsHasParts && !showCustomComponents ? (
        <button type="button" className="btn btn-secondary" onClick={() => setShowCustomComponents(true)}>
          Say what its parts are
        </button>
      ) : null}
      {isPhrase || claimsHasParts || showCustomComponents ? (
        <div aria-label="Component picker">
          <h4>{isPhrase ? 'The words of this phrase, in order' : 'Which words is it made of?'}</h4>
          <p className="field-note">
            {isPhrase ? (
              <>
                One entry per word of <strong>{shownDisplayText}</strong>, in the order they are said. Words already in
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
            <div className="selection-tray" aria-label="Selected parts tray">
              <strong>{draftComponents.length} {draftComponents.length === 1 ? 'part' : 'parts'} selected</strong>
            <ul aria-label="Draft components" className="plain-list">
              {draftComponents.map((componentWordId, i) => {
                const drafted = draftLabels[componentWordId];
                return (
                  <li key={`${i}-${componentWordId}`} className="search-result-row">
                    {/* The order itself, said out loud - saved as component_position, part of the
                        primary key, not a display nicety. A reduplication holds the same word
                        twice, which is also why this is keyed by position rather than wordId. */}
                    <span className="component-position" aria-hidden="true">
                      {i + 1}.
                    </span>
                    {/* The word, not its word_id. A requested word's id is derived and
                        deliberately never shown - it is a key, and showing it would invite
                        someone to ask for a different one, which is exactly what would break
                        agreement between two volunteers naming the same part. Falls back to the
                        id for components already on record, where that is all we know. */}
                    <span className="result-text">
                      {drafted?.displayText ?? componentWordId}
                      {drafted?.pending ? <em> — will be added once a curator approves</em> : null}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => moveDraftComponent(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${drafted?.displayText ?? componentWordId} earlier`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => moveDraftComponent(i, 1)}
                      disabled={i === draftComponents.length - 1}
                      aria-label={`Move ${drafted?.displayText ?? componentWordId} later`}
                    >
                      ↓
                    </button>
                    {/* Reduplication (méjì méjì, mẹ́ta mẹ́ta...) is ordinary Yoruba morphology, not a
                        mistake - but re-picking the same word from search below is refused, on
                        purpose, to catch an accidental double-click. This is the deliberate way to
                        get a genuine second copy instead. */}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => duplicateDraftComponent(i)}
                      aria-label={`Duplicate ${drafted?.displayText ?? componentWordId}`}
                    >
                      Duplicate
                    </button>
                    <button type="button" className="btn btn-danger" onClick={() => removeManualComponent(i)}>
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
              <button type="button" className="btn btn-primary" onClick={saveCustomComponents} disabled={answerRecorded}>
                {answerRecorded ? 'Answer recorded ✓' : label('Save these parts')}
              </button>
            </div>
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
            isSelected={(r) =>
              (r.kind === 'held' ? `held:${r.wordId}` : `corpus:${r.entryId}`) in selectedCandidateWordIds
            }
            selectLabel="Add"
            selectedLabel="Added ✓"
            selectingLabel="Adding…"
            placeholder="Search for a part..."
            resultsAriaLabel="Component search results"
          />
          <div className="btn-row">
            <RequestUnlistedWord onRequested={acceptRequestResult} />
          </div>
          {/* Only offered once something is actually picked - saving an empty custom
              list asserted "these are the parts" about nothing. */}
        </div>
      ) : null}

      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

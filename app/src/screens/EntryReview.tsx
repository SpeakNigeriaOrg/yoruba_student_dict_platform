// screens/EntryReview.tsx
//
// GET /api/words/{wordId}/entry - the entry axis: a word's written form AND
// its meaning, reviewed as ONE task.
//
// ---------------------------------------------------------------------------
// The submit topology, which has not changed
// ---------------------------------------------------------------------------
// SpellingReview/DefinitionReview had five submit buttons between them, each
// writing a fragment immediately, so a word could end up with its form blessed
// and its sense unreviewed. Here every control only SELECTS into local state and
// one primary button submits both halves together. That invariant is load-bearing
// and everything below preserves it.
//
// ---------------------------------------------------------------------------
// What did change: an entry IS a Wiktionary etymology
// ---------------------------------------------------------------------------
// A cited word is asked two questions, and they are different in kind:
//
//   SPELLING - does our spelling match the etymology's? A change here is a
//   CORRECTION: it asserts the spelling on record is wrong.
//
//   STUDENT DEFINITION - what wording will a student understand? A change here is
//   a SIMPLIFICATION, not a correction. Wiktionary's gloss can be perfectly
//   accurate and still be useless to a learner, and rewording it says nothing
//   against upstream. The screen states this, because a volunteer who thinks they
//   are correcting Wiktionary will hesitate over an edit they should make freely.
//
// Both render from the PIN - the copy of the etymology taken when a human
// validated it - so no live Kaikki lookup happens here and upstream changing
// cannot alter a task mid-flight.
//
// ---------------------------------------------------------------------------
// Why the volunteer screen is so much smaller now
// ---------------------------------------------------------------------------
// diagnoseEntry's machinery - status strings, matchedForm, adoptionTarget, the
// candidate list, manual Kaikki search - exists to GUESS which etymology an
// uncited word belongs to. A cited word has nothing to guess, so for a volunteer
// none of it is shown. It remains, curator-only, for the words that predate
// citations and for a curator who needs to re-link one.
//
// It also removes a real defect. adoptionTarget is populated even when nothing
// differs, so a word whose spelling already matched showed "Keep our spelling
// (adìyẹ)" next to "Adopt Kaikki's spelling (adìyẹ)" - two buttons, the same
// word, no choice being made. A spelling choice now appears only when the
// spellings actually differ.

import { useEffect, useState } from 'react';
import {
  classifyToneMatch,
  syllabifySpans,
  type KaikkiSearchResult,
} from '@yoruba-student-dict-platform/shared';
import {
  deleteWord,
  getEntryReview,
  getWordDeletionImpact,
  postEntryDecision,
  renameWord,
  searchKaikki,
  submitEntryContribution,
  type ApplyEntryDecisionInput,
  type EntryReviewResult,
  type WordDeletionImpact,
} from '../api.js';
import { AxisBanner } from './AxisBanner.js';
import { PhraseComposer } from './PhraseComposer.js';
import { phraseSyllables, splitPhrase } from './phraseWords.js';
import { SearchBox } from './SearchBox.js';
import { ToneEditor } from './ToneEditor.js';

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
  /** Off in the task queue. Forwarded to AxisBanner: the word and its syllables
   * stay (they are the task), the three axis chips go (they duplicate the tab bar,
   * which the queue does not show either). */
  showAxisChips?: boolean;
  /** Renaming and deleting the entry, which only the word route offers.
   *
   * One object rather than two optional callbacks, so "both or neither" is structural:
   * both actions navigate away from the word being reviewed (to its new id, or off it
   * entirely), and a screen that cannot navigate must not present them. The task queue
   * passes nothing, which is why a volunteer working a queue is never one mis-tap from
   * deleting the word they were handed. */
  entryAdmin?: {
    onRenamed: (newWordId: string) => void;
    onDeleted: (wordId: string) => void;
  };
}

/** The written-form half of the pending decision. Held as one value rather
 * than loose fields so the UI can render exactly which choice is armed, and
 * so submitting can't accidentally send two conflicting actions. */
type SpellingChoice =
  | { action: 'keep_ours' }
  | { action: 'adopt_kaikki'; newDisplayText: string }
  | { action: 'respell'; newDisplayText: string; newSyllables: string[]; senseEntryId?: string }
  | { action: 'select_candidate'; candidateForm: string; senseEntryId?: string };

/** Which etymology, and how it is spelled, are TWO questions - and answering one must not
 * silently discard the other.
 *
 * This used to be a plain `pick ?? edited`, on the reasoning that a curator's Kaikki pick
 * "resolves WHICH etymology the word is - a different question from how it is spelled". That
 * is exactly the argument for not letting it win: `select_candidate` never writes display_text
 * (see applyEntryDecision), so a curator who corrected the tone AND linked the record got the
 * link and lost the tone, with the "Reads:" line still showing the correction they had made.
 * Silent, and unrecoverable without noticing and redoing it.
 *
 * The etymology half of a pick is `senseEntryId`, which is already an independent field on
 * ApplyEntryDecisionInput and applies regardless of `action`. So an edited spelling keeps the
 * action and carries the pick's etymology along with it, and both halves land.
 *
 * A pick still wins outright when the spelling was NOT edited: `keep_ours` says nothing the
 * pick does not say better, and `select_candidate` is then the more specific claim. */
function resolveWrittenForm(pick: SpellingChoice | null, edited: SpellingChoice | null): SpellingChoice | null {
  if (edited?.action !== 'respell') return pick ?? edited;
  const senseEntryId = pick && 'senseEntryId' in pick ? pick.senseEntryId : undefined;
  return senseEntryId ? { ...edited, senseEntryId } : edited;
}

/** Compared NFC-normalized, for the same reason writtenFormFromSyllables is: a
 * difference of Unicode composition alone is not an edit, and five production words
 * store their text in NFD. */
function sameSyllables(a: string[], b: string[] | null): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((s, i) => s.normalize('NFC') === b[i].normalize('NFC'));
}

/** The written-form half, derived from the syllable row.
 *
 * Unchanged syllables mean the reviewer left the word as it stands - keep_ours, the
 * same claim as before. Changed syllables mean they wrote this spelling themselves,
 * which is 'respell': adopt_kaikki cannot express it (that action re-verifies against
 * Kaikki's own suggestion, and a tone correction is usually neither our spelling nor
 * Kaikki's) and keep_ours cannot either (it never touches display_text).
 *
 * Compared NFC-normalized, so a difference of Unicode composition alone is not
 * mistaken for an edit.
 *
 * Null when there are no syllables to work from, which forces the caller to fall back
 * to an explicit choice rather than submitting an empty spelling. */
function writtenFormFromSyllables(currentDisplayText: string, syllables: string[] | null): SpellingChoice | null {
  if (!syllables || syllables.length === 0) return null;
  const proposed = syllables.join('');
  if (proposed.normalize('NFC') === currentDisplayText.normalize('NFC')) return { action: 'keep_ours' };
  return { action: 'respell', newDisplayText: proposed, newSyllables: syllables };
}

/** The same thing for a PHRASE, whose spelling is composed rather than assembled from a
 * single syllable row.
 *
 * A multi-word spelling has no syllable row at all - syllabifySpans refuses anything with a
 * space in it - so this screen used to say the spelling "can only be changed by a curator"
 * and offer only Confirm. That was already awkward and became untrue: a phrase's spelling
 * used to be re-derived from its components on the etymology axis, and once that stopped
 * (correctly - see api/src/handlers/applyEntryDecision.ts's note) there was no route left
 * for anyone, curator or not, to correct `fi sílẹ̀`.
 *
 * The syllables come from the composed text rather than from the stored column, exactly as
 * the single-word path derives them from display_text: production holds a word whose two
 * disagree, and seeding from the column would apply that discrepancy to whatever the
 * reviewer submits. */
function writtenFormFromPhrase(currentDisplayText: string, phraseText: string | null): SpellingChoice | null {
  if (phraseText === null) return null;
  const trimmed = phraseText.trim();
  if (!trimmed) return null;
  if (trimmed.normalize('NFC') === currentDisplayText.normalize('NFC')) return { action: 'keep_ours' };
  const newSyllables = phraseSyllables(splitPhrase(trimmed).words);
  if (newSyllables.length === 0) return null;
  return { action: 'respell', newDisplayText: trimmed, newSyllables };
}

export function EntryReview({ wordId, isCurator, onDecided, showAxisChips = true, entryAdmin }: EntryReviewProps) {
  const [review, setReview] = useState<EntryReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pending decision, both halves.
  //
  // `syllables` is the written-form half: the word as the reviewer currently has it,
  // one entry per syllable, tone included. Null until the review loads, or when the
  // word cannot be represented as syllables at all (see syllabifySpans - Ajami
  // spellings, hyphenated forms). Editing it IS disagreeing; there is no separate
  // yes/no, which is what stops the screen from only being able to record agreement.
  const [syllables, setSyllables] = useState<string[] | null>(null);
  /** The composed spelling, for a multi-word entry only.
   *
   * A phrase gets this instead of `syllables`, never as well: syllabifySpans refuses a
   * spelling with a space in it, so there is no single syllable row for the tone editor to
   * work on, and the composer holds the whole phrase and grids each word separately. Null
   * for a single word, which is what keeps the two paths from both claiming to decide the
   * spelling. */
  const [phraseText, setPhraseText] = useState<string | null>(null);
  const [editingLetters, setEditingLetters] = useState(false);
  /** The syllables as they stood when the letters editor was opened, so Discard can put
   * them back. Snapshotted on OPEN rather than on load, so tone choices made carefully
   * before opening the letters editor survive a discard - only what changed inside the
   * letters editor is thrown away. */
  const [lettersSnapshot, setLettersSnapshot] = useState<string[] | null>(null);
  const [spelling, setSpelling] = useState<SpellingChoice | null>(null);
  const [syllableAction, setSyllableAction] = useState<'keep_manual' | 'accept_programmatic' | undefined>(undefined);
  const [definitionText, setDefinitionText] = useState('');
  const [definitionSourceForm, setDefinitionSourceForm] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  /** Curator-only escape hatch, collapsed by default. Re-linking or overriding
   * the matched record is not part of a routine review even for a curator. */
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    setStatus(null);
    setSpelling(null);
    setSyllables(null);
    setPhraseText(null);
    setEditingLetters(false);
    setLettersSnapshot(null);
    setSyllableAction(undefined);
    setShowTools(false);
    getEntryReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setReview(result);
        // Derived from display_text, NOT from the stored syllables column: production
        // contains a word whose two disagree (agunfon_giraffe, 'àgùnfon' vs
        // ['à','gùn','fọn']), and seeding from the column would silently apply that
        // discrepancy to whatever the reviewer submitted.
        // Routed on what the tone grid can actually take, not on how many words this is.
        //
        // Three cases, in order of how much can be edited:
        //
        //   syllabifySpans represents the WHOLE spelling   -> the syllable row.
        //   it cannot, but the pieces between separators
        //   can be represented                             -> the composer, one grid per piece.
        //   nothing can be represented                     -> read-only.
        //
        // One predicate covering the space and the hyphen together, where the isMultiWord test
        // it replaces covered only the space - leaving every hyphenated entry (`ilé-ìwé`,
        // `aárùn-ún`) on a branch that says a curator must fix it. The last case is still real
        // and still refuses: an Ajami spelling like `شعِ` has no syllable model at all, and a
        // text box with no grids would let it be silently mangled.
        const spans = syllabifySpans(result.displayText);
        if (spans) {
          setSyllables(spans);
        } else if (splitPhrase(result.displayText).words.some((w) => w.syllables !== null)) {
          setPhraseText(result.displayText);
        }
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
   * updating source and draft text together.
   *
   * Now also carries the etymology id, so the pick is stored as the etymology
   * chosen rather than as a form string that identifies nothing. */
  function useSearchResult(result: KaikkiSearchResult) {
    setSpelling({
      action: 'select_candidate',
      candidateForm: result.form,
      ...(result.entryId ? { senseEntryId: result.entryId } : {}),
    });
    setDefinitionSourceForm(result.form);
    if (result.glosses.length > 0) setDefinitionText(result.glosses[0]);
  }

  async function submit() {
    if (!review) return;
    // The written-form half. The syllable row (or the phrase composer) decides it:
    // unchanged means keep_ours, changed means the reviewer wrote this spelling
    // themselves. A curator-only candidate/search pick contributes the etymology to
    // that rather than replacing it - see resolveWrittenForm.
    const written = resolveWrittenForm(
      spelling,
      writtenFormFromSyllables(review.displayText, syllables) ??
        writtenFormFromPhrase(review.displayText, phraseText),
    );
    if (!written) {
      setStatus('Answer the spelling question first - an entry is decided as a whole.');
      return;
    }
    if (!definitionText.trim()) {
      setStatus('Enter a student definition first - an entry is decided as a whole.');
      return;
    }

    // 'confirm' only means anything when the text is unchanged from what is
    // already on record; any edit is a custom definition.
    const unchanged = definitionText.trim() === (review.definitionCurrent ?? '').trim();
    const input: ApplyEntryDecisionInput = {
      ...written,
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
        setStatus('Thanks - your answer is recorded.');
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

  const pin = review.citation?.pin ?? null;
  const upstreamForm = pin?.canonicalForm ?? null;
  const upstreamGlosses = pin?.glosses ?? [];
  const isExempt = Boolean(review.citation?.exemptReason);
  const written = resolveWrittenForm(
    spelling,
    writtenFormFromSyllables(review.displayText, syllables) ??
      writtenFormFromPhrase(review.displayText, phraseText),
  );
  const readyToSubmit = Boolean(written) && definitionText.trim().length > 0;
  const proposed = syllables ? syllables.join('') : (phraseText?.trim() ?? review.displayText);
  // The specific kind of difference, not a bare "differs". classifyToneMatch already
  // separates a tone disagreement from a letters one, and that distinction is the
  // whole point of this screen - it was previously computed and thrown away.
  const vsUpstream = upstreamForm ? classifyToneMatch(proposed, upstreamForm) : null;

  return (
    <section aria-label="Entry review" className={`card${review.axisDecided.entry ? ' decided' : ''}`}>
      <AxisBanner
        displayText={review.displayText}
        syllables={review.syllables}
        definition={review.definitionCurrent}
        axisDecided={review.axisDecided}
        currentAxis="Entry"
        showAxisChips={showAxisChips}
      />

      <h3>Spelling and tone</h3>
      {syllables ? (
        <>
          <ToneEditor
            syllables={syllables}
            onChange={setSyllables}
            editingLetters={editingLetters}
            onEditLetters={() => {
              setLettersSnapshot(syllables);
              setEditingLetters(true);
            }}
            onKeepLetters={() => {
              setLettersSnapshot(null);
              setEditingLetters(false);
            }}
            onCancelLetters={() => {
              if (lettersSnapshot) setSyllables(lettersSnapshot);
              setLettersSnapshot(null);
              setEditingLetters(false);
            }}
            lettersDirty={lettersSnapshot !== null && !sameSyllables(lettersSnapshot, syllables)}
          />

          <p aria-label="Spelling comparison">
            Reads: <strong>{proposed}</strong>
            {/* Says so when the reviewer has deviated from the record, and from what.
                Without this, tapping a tone produced no acknowledgement that anything
                had changed - and no way to find the way back other than remembering it.
                Every alternative is visible in the grid, so naming the original is
                enough; a second reset button would clutter the primary path. */}
            {proposed.normalize('NFC') !== review.displayText.normalize('NFC') ? (
              <>
                {' '}
                <span className="changed-note" aria-label="Changed from">
                  (changed from {review.displayText})
                </span>
              </>
            ) : null}
            {upstreamForm ? (
              <>
                <br />
                {vsUpstream === 'match'
                  ? `Wiktionary has ${upstreamForm} - the same.`
                  : vsUpstream === 'tone_mismatch'
                    ? `Wiktionary has ${upstreamForm} - same letters, different tone.`
                    : `Wiktionary has ${upstreamForm} - the letters differ, not just the tone.`}
              </>
            ) : isExempt ? (
              <>
                <br />
                This word has no Wiktionary entry, so there is nothing to compare against.
              </>
            ) : (
              <>
                <br />
                This word is not linked to a Wiktionary etymology yet.
              </>
            )}
          </p>
        </>
      ) : phraseText !== null ? (
        // A phrase. Composed rather than assembled from a syllable row, because
        // syllabifySpans refuses a spelling with a space in it - the composer splits on
        // whitespace itself and grids each word separately, which is the same component the
        // Add Phrase tab authors with, so a phrase is corrected here the way it was written.
        <>
          <p aria-label="Spelling question">
            We have <strong>{review.displayText}</strong>. It is more than one word, so each word gets its own tone
            grid. Edit it if the spelling or the tone is wrong.
          </p>
          <PhraseComposer
            id="entry-phrase-spelling"
            label="The phrase, spelled as it is said"
            value={phraseText}
            onChange={setPhraseText}
          />
          <p aria-label="Spelling comparison">
            Reads: <strong>{proposed}</strong>
            {proposed.normalize('NFC') !== review.displayText.normalize('NFC') ? (
              <>
                {' '}
                <span className="badge not-started">changed from {review.displayText}</span>
              </>
            ) : null}
            {/* What Wiktionary has, said out loud - which this branch did not do at all.
                Only the single-word branch above showed it, so a phrase whose citation was
                pinned to a record spelled `o ṣé` while we held `o ṣe` displayed nothing:
                the right answer was sitting in the pin, invisible, on the one screen whose
                job is to settle the spelling. The pin already carries it for a phrase as
                readily as for a word - buildPin copies canonicalForm whatever the entry is -
                so this is the same two lines, not a new comparison. */}
            {upstreamForm ? (
              <>
                <br />
                {vsUpstream === 'match'
                  ? `Wiktionary has ${upstreamForm} - the same.`
                  : vsUpstream === 'tone_mismatch'
                    ? `Wiktionary has ${upstreamForm} - same letters, different tone.`
                    : `Wiktionary has ${upstreamForm} - the letters differ, not just the tone.`}
                {vsUpstream === 'match' ? null : (
                  <>
                    {' '}
                    {/* Loads the composer, rather than submitting. Upstream's spelling is a
                        strong proposal and not an authority - it travels as a `respell`, the
                        same action a hand-typed correction takes, so a curator still reads the
                        grids and can disagree with any one syllable before confirming. There is
                        no adopt_kaikki route here in any case: diagnoseEntry returns early for a
                        phrase and computes no adoptionTarget, so the server would reject one. */}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setPhraseText(upstreamForm)}
                    >
                      Use Wiktionary&apos;s spelling
                    </button>
                  </>
                )}
              </>
            ) : isExempt ? (
              <>
                <br />
                This phrase has no Wiktionary entry, so there is nothing to compare against.
              </>
            ) : (
              <>
                <br />
                This phrase is not linked to a Wiktionary etymology yet.
              </>
            )}
          </p>
        </>
      ) : (
        // syllabifySpans could not represent this SINGLE word - an Ajami spelling or a
        // hyphenated form. Editing it here would silently drop the characters the
        // syllabifier does not model, so it is left alone and the reviewer can only confirm
        // or skip. Multi-word forms took this branch too until the phrase path above
        // existed, which is how a phrase became uncorrectable.
        <>
          <p aria-label="Spelling question">
            We have <strong>{review.displayText}</strong>. This word cannot be broken into syllables here, so its
            spelling can only be changed by a curator.
          </p>
          <div className="btn-row" role="group" aria-label="Spelling choice">
            <button
              type="button"
              className={`btn ${spelling?.action === 'keep_ours' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={spelling?.action === 'keep_ours'}
              onClick={() => setSpelling({ action: 'keep_ours' })}
            >
              The spelling is right
            </button>
          </div>
        </>
      )}

      {review.syllableSplitStatus === 'mismatch' ? (
        <>
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

      <h3>Student definition</h3>
      {upstreamGlosses.length > 0 ? (
        <p className="field-note" aria-label="Upstream glosses">
          Wiktionary says: {upstreamGlosses.join('; ')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="entry-definition-field">Student definition</label>
        <textarea
          id="entry-definition-field"
          value={definitionText}
          onChange={(e) => setDefinitionText(e.target.value)}
        />
      </div>
      <p className="field-note">
        Plain wording a student will understand. Simplifying Wiktionary's wording is expected - it is a simplification,
        not a correction.
      </p>

      <button type="button" className="btn btn-primary" onClick={submit} disabled={!readyToSubmit || submitting}>
        {isCurator ? 'Confirm entry' : 'Confirm'}
      </button>
      {!readyToSubmit ? (
        <p className="field-note">
          Spelling and definition are decided together - answer the spelling question and enter a definition.
        </p>
      ) : null}
      {status ? (
        <p role="status" className="status-banner">
          {status}
        </p>
      ) : null}

      {isCurator ? (
        <CuratorTools
          review={review}
          expanded={showTools}
          onToggle={() => setShowTools((v) => !v)}
          spelling={spelling}
          onPickCandidate={(candidateForm, senseEntryId) =>
            setSpelling({ action: 'select_candidate', candidateForm, ...(senseEntryId ? { senseEntryId } : {}) })
          }
          onUseSearchResult={useSearchResult}
          note={note}
          onNoteChange={setNote}
        />
      ) : null}

      {isCurator && entryAdmin ? (
        <EntryDangerZone
          wordId={wordId}
          displayText={review.displayText}
          onRenamed={entryAdmin.onRenamed}
          onDeleted={entryAdmin.onDeleted}
        />
      ) : null}
    </section>
  );
}

/** Everything a volunteer should not be handed: the raw diagnosis vocabulary, the
 * candidate list for a word whose etymology was never established, manual Kaikki
 * re-linking, and the free-text note.
 *
 * These are instruments for deciding WHICH etymology a word is - a question the
 * standard flow answers at creation. Reaching for them means something is off
 * about the word itself, which is curator work by definition. Collapsed by
 * default so it is not the shape of a routine review even for a curator. */
function CuratorTools({
  review,
  expanded,
  onToggle,
  spelling,
  onPickCandidate,
  onUseSearchResult,
  note,
  onNoteChange,
}: {
  review: EntryReviewResult;
  expanded: boolean;
  onToggle: () => void;
  spelling: SpellingChoice | null;
  onPickCandidate: (candidateForm: string, senseEntryId?: string) => void;
  onUseSearchResult: (result: KaikkiSearchResult) => void;
  note: string;
  onNoteChange: (value: string) => void;
}) {
  const candidates = review.candidatesConsidered ?? [];

  return (
    <div className="curator-tools">
      <button type="button" className="btn btn-secondary" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? 'Hide curator tools' : 'Curator tools'}
      </button>
      {!expanded ? null : (
        <div aria-label="Curator tools">
          <p aria-label="Spelling diagnosis">
            <strong>Diagnosis:</strong> {review.status}
            {review.matchedForm ? (
              <>
                <br />
                Matched form: <strong>{review.matchedForm}</strong>
              </>
            ) : null}
            <br />
            Cites:{' '}
            <strong>
              {review.citation?.entryId ??
                (review.citation?.exemptReason ? `exempt - ${review.citation.exemptReason}` : 'nothing yet')}
            </strong>
            {review.citation?.pin?.etymologyNumber ? ` (etymology ${review.citation.pin.etymologyNumber})` : ''}
          </p>

          {candidates.length > 0 ? (
            <>
              <h4>Which etymology is this word?</h4>
              <ul aria-label="Candidates considered" className="plain-list">
                {candidates.map((c, i) => (
                  <li key={c.entryId ?? i}>
                    <label>
                      <input
                        type="radio"
                        name="candidate"
                        value={c.entryId ?? c.form}
                        checked={
                          spelling?.action === 'select_candidate' &&
                          (c.entryId ? spelling.senseEntryId === c.entryId : spelling.candidateForm === c.form)
                        }
                        onChange={() => onPickCandidate(c.form, c.entryId ?? undefined)}
                      />
                      <strong>{c.form}</strong> ({c.pos}
                      {c.etymologyNumber ? `, etymology ${c.etymologyNumber}` : ''}) - {c.glosses.join('; ')}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h4>Re-link to a different etymology</h4>
          <p className="field-note">Picking a record re-cites the word and retargets the definition source.</p>
          <SearchBox
            search={searchKaikki}
            renderResult={(r) => (
              <>
                <strong>{r.form}</strong> ({r.pos}
                {r.etymologyNumber ? `, etymology ${r.etymologyNumber}` : ''}) - {r.glosses.join('; ')}
              </>
            )}
            onSelect={onUseSearchResult}
            selectLabel="Use this record"
            placeholder="Search Kaikki..."
            resultsAriaLabel="Kaikki search results"
          />

          <div className="field">
            <label htmlFor="entry-note-field">Note</label>
            <textarea id="entry-note-field" value={note} onChange={(e) => onNoteChange(e.target.value)} aria-label="Note" />
          </div>
        </div>
      )}
    </div>
  );
}

/** Renaming and deleting the entry itself - the two operations that act on the word rather
 * than on a claim about it.
 *
 * ---------------------------------------------------------------------------
 * Why they are here and not in Browse
 * ---------------------------------------------------------------------------
 * A list row is where you tap to navigate, dozens of times an hour, on a phone. Putting an
 * irreversible action there is asking for the mis-tap. Reaching this needs the word open and
 * the section expanded, and neither happens by accident.
 *
 * ---------------------------------------------------------------------------
 * Why rename is offered at all, given delete exists
 * ---------------------------------------------------------------------------
 * They are not alternatives. Delete-and-re-add loses every recording, image, example and
 * review decision attached to the word; rename keeps all of it. The wrong id noticed five
 * minutes after adding the word can go either way, and the one noticed after a term of
 * recording can only be renamed.
 *
 * ---------------------------------------------------------------------------
 * No client-side check on the new id
 * ---------------------------------------------------------------------------
 * Deliberate. api/src/handlers/wordIdShape.ts is the single statement of what a word_id may
 * be, and its error says WHY (the id becomes a filename, a URL and a storage key). A regex
 * copied into this file is the exact drift that file's own header describes hitting once
 * already, and it would answer with less than the server does.
 */
function EntryDangerZone({
  wordId,
  displayText,
  onRenamed,
  onDeleted,
}: {
  wordId: string;
  displayText: string;
  onRenamed: (newWordId: string) => void;
  onDeleted: (wordId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [impact, setImpact] = useState<WordDeletionImpact | null>(null);
  const [newWordId, setNewWordId] = useState(wordId);
  /** The retyped id. Not a checkbox: the point is to make the curator name the specific word
   * they are destroying, on a screen where several words look alike by design. */
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Everything resets on the word, including `expanded` - arriving at a new word with the
  // danger zone already open (and the previous word's impact still on screen) is how the
  // wrong entry gets deleted.
  useEffect(() => {
    setExpanded(false);
    setImpact(null);
    setNewWordId(wordId);
    setConfirmText('');
    setError(null);
  }, [wordId]);

  // Fetched on expand rather than on load: it is a handful of counts nobody needs while
  // reviewing, and it must be FRESH when read, not as of whenever the screen opened.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setImpact(null);
    getWordDeletionImpact(wordId)
      .then((result) => {
        if (!cancelled) setImpact(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, wordId]);

  async function submitRename() {
    setBusy(true);
    setError(null);
    try {
      const result = await renameWord(wordId, newWordId.trim());
      onRenamed(result.to);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDelete() {
    setBusy(true);
    setError(null);
    try {
      // confirm is sent unconditionally: the curator has retyped the id against the impact
      // shown above, which is a stronger statement than the flag itself. The server still
      // decides whether it was needed.
      await deleteWord(wordId, true);
      onDeleted(wordId);
    } catch (err) {
      setError((err as Error).message);
      // The impact is the thing that just changed under them if this failed on a stale
      // count, so re-read it rather than leaving the old numbers on screen.
      getWordDeletionImpact(wordId)
        .then(setImpact)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const blocked = (impact?.usedAsComponentOf.length ?? 0) > 0;
  const renameReady = newWordId.trim().length > 0 && newWordId.trim() !== wordId && !busy;
  const deleteReady = confirmText.trim() === wordId && !blocked && !busy;

  return (
    <div className="curator-tools">
      <button type="button" className="btn btn-secondary" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide entry admin' : 'Entry admin'}
      </button>
      {!expanded ? null : (
        <div aria-label="Entry admin">
          <h4>Change this word&apos;s id</h4>
          <p className="field-note">
            The id is what every recording, image and published file is named from - it is not the spelling. Renaming
            moves all of them; nothing attached to <strong>{displayText}</strong> is lost.
          </p>
          <div className="field">
            <label htmlFor="rename-word-id-field">Word ID</label>
            <input
              id="rename-word-id-field"
              type="text"
              value={newWordId}
              onChange={(e) => setNewWordId(e.target.value)}
              aria-label="New word ID"
            />
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void submitRename()} disabled={!renameReady}>
            Rename
          </button>

          <h4>Delete this entry</h4>
          {impact === null ? (
            <p className="field-note">Checking what is attached...</p>
          ) : blocked ? (
            <div className="warning-banner" aria-label="Deletion blocked">
              <strong>{impact.usedAsComponentOf.length}</strong> other{' '}
              {impact.usedAsComponentOf.length === 1 ? 'entry is' : 'entries are'} built from this word (
              {impact.usedAsComponentOf.join(', ')}). Change their components first, or rename this word instead.
            </div>
          ) : impact.attachedTotal === 0 ? (
            <p className="field-note">Nothing is attached to this entry - deleting it loses no recorded work.</p>
          ) : (
            <div className="warning-banner" aria-label="Deletion impact">
              Deleting <strong>{wordId}</strong> permanently destroys:
              <ul className="plain-list">
                {impact.attached.map((a) => (
                  <li key={a.label}>
                    {a.count} {a.label}
                  </li>
                ))}
              </ul>
              Audio is stored in the database, not in a bucket with versions - none of this can be recovered.
            </div>
          )}
          {impact !== null && !blocked ? (
            <>
              <div className="field">
                <label htmlFor="delete-confirm-field">Type {wordId} to confirm</label>
                <input
                  id="delete-confirm-field"
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  aria-label="Confirm word ID"
                />
              </div>
              <button type="button" className="btn btn-danger" onClick={() => void submitDelete()} disabled={!deleteReady}>
                Delete entry
              </button>
            </>
          ) : null}

          {error ? (
            <p role="alert" className="status-banner">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

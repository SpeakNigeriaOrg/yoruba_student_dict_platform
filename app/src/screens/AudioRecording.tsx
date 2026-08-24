// screens/AudioRecording.tsx
//
// The 4th axis tab: records the two-take protocol (see
// REMOTE_ACCESS_DISCUSSION.md's "Audio pipeline" section) - recording 1,
// the speaker saying the word naturally, just once; recording 2, the
// speaker saying it again but enunciating each syllable individually and
// cleanly, with a pause between syllables, which gets decoded, segmented
// (segmentSyllables.ts), and sliced into one WAV clip per detected
// syllable for review before submitting.
//
// Real backend (registerUtterance), storing audio bytes directly in
// Postgres rather than Blob Storage (short-term storage decision - see
// api/src/handlers/registerUtterance.ts's file header) - no SAS token or
// separate upload step needed, submit() sends the clips straight to the
// register endpoint.
//
// Pronunciation, not just speaker identity, is tracked per recording: a
// speaker may record under a tentative spelling/tone that golden_record
// later converges on something different from, so this screen lets the
// speaker confirm/edit the spelling and syllable split they're actually
// about to say (defaulting to the word's current values) - that's what
// gets sent as recordedDisplayText/recordedSyllables and is what the
// segment-count check and syllable identities are actually based on, not
// necessarily golden_record's current (possibly later-revised) values.
//
// A volunteer sees their OWN recordings and nobody else's; a curator sees every speaker's,
// in a section kept clearly separate from their own rather than blended into one list.
//
// Hearing someone else say the word before recording it is an anchor, and the whole reason
// every participant records every word themselves is to get INDEPENDENT pronunciations - the
// divergence between speakers is the signal being collected, so supplying a reference take
// quietly converts it into imitation. It is also other people's voices, which a volunteer has
// no task that needs. A curator does: comparing speakers is how coverage gets judged.
//
// The API enforces this too (listUtterances.ts) - a volunteer is never sent the other
// recordings, so this is not a hidden section with the audio still in the page. Same reason
// the Audio axis tab's own green/pending status is scoped to the current user's recordings
// rather than any speaker's.

import { useEffect, useState } from 'react';
import { syllabifySpans, toneOf } from '@yoruba-student-dict-platform/shared';
import { decodeToSamples } from '../audio/decodeToSamples.js';
import { PhraseComposer } from './PhraseComposer.js';
import { phraseSyllables, splitPhrase } from './phraseWords.js';
import { ToneGrid } from './ToneGrid.js';
import { sliceAndEncodeWav } from '../audio/encodeWav.js';
import { segmentSyllables, type SyllableSegment } from '../audio/segmentSyllables.js';
import { useAudioRecorder } from '../audio/useAudioRecorder.js';
import { base64ToAudioUrl, getEntryReview, listUtterances, registerUtterance, type UtteranceSummary } from '../api.js';

export interface AudioRecordingProps {
  wordId: string;
  /** Whether other speakers' recordings are shown at all. Curator-only, and the API agrees -
   * a volunteer is not sent them, so this gates a section that would otherwise be empty. */
  isCurator: boolean;
  /** Called after a recording is successfully registered, so the task queue
   * can advance. */
  onDecided?: () => void;
}

interface SegmentReview {
  segment: SyllableSegment;
  clip: Blob;
}

// Deliberately doesn't render `status` (pending_processing/segmented) -
// that field describes internal segmentation state, not "did I finish
// recording this," and showing it to the person recording (especially
// "pending_processing" on their own freshly-submitted take 1, which is
// simply never expected to change - take 1 is never segmented) reads as
// an error or an unfinished step when it isn't one. Segment count is
// shown instead, since that's the part actually meaningful to a listener.
function UtteranceRow({ u, showSpeakerName }: { u: UtteranceSummary; showSpeakerName: boolean }) {
  return (
    <li>
      {showSpeakerName ? (
        <>
          <strong>{u.speakerDisplayName}</strong> -{' '}
        </>
      ) : null}
      take {u.takeNumber} - recorded as{' '}
      <em>
        {u.recordedDisplayText} ({u.recordedSyllables.join(' · ')})
      </em>
      {/* The recording is not wrong - it says what the speaker actually said.
          What changed is the word underneath it, and the consequence is that the
          publish step drops this take silently. Saying so here is the whole
          point of preserving the recorded pronunciation separately. */}
      {u.divergesFromGolden ? (
        <>
          {' '}
          <span className="badge diverged">no longer matches</span>
        </>
      ) : null}
      {u.segments.length > 0 ? (
        <span>
          {' '}
          ({u.segments.length} syllable{u.segments.length === 1 ? '' : 's'} identified)
        </span>
      ) : null}
      {u.audioDataBase64 ? (
        <>
          <br />
          <audio controls src={base64ToAudioUrl(u.audioDataBase64)} />
        </>
      ) : null}
      {/* plain-list, not a default <ul>: this is a list nested inside an <li>,
          so browser default indentation stacked twice and pushed a ~250-300px
          native audio player ~80px in from the left on a 360px screen. */}
      {u.segments.length > 0 ? (
        <ul aria-label={`take ${u.takeNumber} segments`} className="plain-list segment-list">
          {u.segments.map((seg) => (
            <li key={seg.syllablePosition}>
              Syllable {seg.syllablePosition + 1} ({seg.syllableText})
              <audio controls src={base64ToAudioUrl(seg.audioDataBase64)} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function AudioRecording({ wordId, isCurator, onDecided }: AudioRecordingProps) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // ---------------------------------------------------------------------------
  // The pronunciation is composed on a tone grid, not typed
  // ---------------------------------------------------------------------------
  // This screen used to ask for a spelling plus a COMMA-SEPARATED syllables string. That made it
  // the one place in the app where tone is a diacritic to squint at, and every other screen makes
  // tone central and unavoidable - a contributor never types an accent, they choose a tone and the
  // mark is generated. It also let someone produce a split that disagreed with the spelling they
  // had just typed, which is precisely what recorded_syllables freezing then preserved forever.
  //
  // So the syllables ARE the state, and the spelling is their join - one source of truth, and the
  // two can no longer disagree. 0006's freeze semantics are unchanged: this is still what the
  // speaker says, captured at recording time, and still allowed to differ from golden_record.
  //
  // Consequence worth knowing: the syllable COUNT is now a function of the spelling. Changing it
  // means editing the spelling or using the nasal control on the grid, not retyping a list.
  const [wordSyllables, setWordSyllables] = useState<string[]>([]);
  /** The composed spelling, for a phrase - anything syllabifySpans refuses as a WHOLE but whose
   * pieces it can represent.
   *
   * This screen used to have no such branch, and syllabifySpans refuses every space and every
   * hyphen, so EVERY phrase in the dictionary fell into the unsplittable fallback below and was
   * told its tones "can't be shown as a grid". That is the population most in need of one: a
   * phrase's tone is exactly what a component's stored spelling gets wrong (`o ṣé` is not `ṣe`
   * at mid tone), and the fallback's comma-separated box is the retyped-list input this screen
   * was rebuilt to remove. Same three-way routing EntryReview already does, for the same reason
   * and off the same splitter, so the two screens agree about what a phrase is. */
  const [phraseText, setPhraseText] = useState<string | null>(null);
  /** Set when syllabifySpans refuses the word - Ajami, hyphenated forms, interjections (805 of
   * 5,580 corpus forms). Those must stay recordable, so they fall back to plain text fields, the
   * same branch and the same reason EntryReview already has. */
  const [unsplittableText, setUnsplittableText] = useState<string | null>(null);
  /** Derived on the phrase path rather than held, so the composed text stays the one source of
   * truth there exactly as the syllable row is on the word path - the two can no longer disagree
   * about what is being recorded. Separators are not syllables, so they do not appear here (see
   * phraseSyllables), while pronunciationText keeps them: `o ṣé` is recorded as two syllables
   * and written with its space. */
  const recordedSyllables = phraseText === null ? wordSyllables : phraseSyllables(splitPhrase(phraseText).words);
  const pronunciationText = unsplittableText ?? phraseText ?? wordSyllables.join('');
  // The word's spelling as golden_record currently holds it. Kept separate from
  // pronunciationText, which the speaker may edit before recording - the
  // divergence warning is about the RECORD, so quoting the editable field would
  // make the message change as they type.
  const [goldenDisplayText, setGoldenDisplayText] = useState('');
  /** golden_record's stored split, kept so the seed can prefer it over a re-derived one - see
   * the load effect. */
  const [goldenSyllables, setGoldenSyllables] = useState<string[]>([]);
  /** Only used on the unsplittable fallback path, where the split cannot be derived. */
  const [fallbackSyllablesText, setFallbackSyllablesText] = useState('');

  const recorder = useAudioRecorder();
  const [take1Blob, setTake1Blob] = useState<Blob | null>(null);
  const [take2Blob, setTake2Blob] = useState<Blob | null>(null);
  const [recordingStep, setRecordingStep] = useState<'take1' | 'take2' | null>(null);

  const [segmentReviews, setSegmentReviews] = useState<SegmentReview[] | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Set when the submission just made will not publish - the server is the authority on that
   * (registerUtterance returns matchesGolden), not the client's own comparison. */
  const [submittedDiverged, setSubmittedDiverged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [previousRecordings, setPreviousRecordings] = useState<UtteranceSummary[] | null>(null);
  const [previousRecordingsError, setPreviousRecordingsError] = useState<string | null>(null);

  function loadPreviousRecordings() {
    listUtterances(wordId)
      .then(setPreviousRecordings)
      .catch((err: unknown) => setPreviousRecordingsError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setTake1Blob(null);
    setTake2Blob(null);
    setSegmentReviews(null);
    setStatus(null);
    setSubmittedDiverged(false);
    setPreviousRecordings(null);
    setPreviousRecordingsError(null);
    setUnsplittableText(null);
    setPhraseText(null);
    getEntryReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setGoldenDisplayText(result.displayText);
        setGoldenSyllables(result.syllables);
        // The STORED split wins when it reconstitutes the spelling, and that ordering is the fix
        // for a real defect. An authored split is a claim, not a derivation: applyEntryDecision's
        // `respell` writes one, and its own comment notes that "freeing a nasal is a respell whose
        // whole content is the new split". Re-deriving here undid exactly that correction - and
        // the re-derived split is then precisely what the publish comparison rejects, so a speaker
        // who changed nothing produced a recording that could never be published.
        //
        // Deriving is still right when the stored split does NOT reconstitute the spelling, which
        // is the disagreement the previous comment was written for (one production word:
        // agunfon_giraffe, 'àgùnfon' vs ['à','gùn','fọn']). Carrying that into a frozen recording
        // would be worse than re-deriving it. NFC-compared, matching the rule applyEntryDecision
        // already enforces on write, so a composition difference alone is not a disagreement.
        //
        // Three cases after that, most editable first, exactly as EntryReview routes them:
        //
        //   the WHOLE spelling is syllabifiable  -> one syllable row.
        //   only the pieces between separators   -> the composer, one grid per piece.
        //   nothing is                           -> the text fallback below.
        const spans = syllabifySpans(result.displayText);
        const storedIsFaithful =
          result.syllables.length > 0 &&
          result.syllables.join('').normalize('NFC') === result.displayText.normalize('NFC');
        if (storedIsFaithful && spans) {
          setWordSyllables(result.syllables);
        } else if (spans) {
          setWordSyllables(spans);
        } else if (splitPhrase(result.displayText).words.some((w) => w.syllables !== null)) {
          setPhraseText(result.displayText);
        } else {
          setUnsplittableText(result.displayText);
          setFallbackSyllablesText(result.syllables.join(','));
          setWordSyllables(result.syllables);
        }
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    loadPreviousRecordings();
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function recordTake(take: 'take1' | 'take2') {
    // Clear the previous blob (re-record case) *before* starting -
    // otherwise the still-truthy take1Blob/take2Blob keeps the "already
    // recorded" branch on screen even once a new recording has actually
    // started, leaving no visible way to stop it.
    if (take === 'take1') {
      setTake1Blob(null);
    } else {
      setTake2Blob(null);
      setSegmentReviews(null);
      setProcessingError(null);
    }
    setRecordingStep(take);
    try {
      await recorder.start();
    } catch {
      // recorder.error is already set and rendered - nothing more to do
      // here, just don't leave the recording step stuck as "active".
      setRecordingStep(null);
    }
  }

  async function stopTake(take: 'take1' | 'take2') {
    const blob = await recorder.stop();
    setRecordingStep(null);
    if (take === 'take1') {
      setTake1Blob(blob);
    } else {
      setTake2Blob(blob);
      await processTake2(blob);
    }
  }

  async function processTake2(blob: Blob) {
    setProcessingError(null);
    setSegmentReviews(null);
    try {
      const { samples, sampleRate } = await decodeToSamples(blob);
      const segments = segmentSyllables(samples, sampleRate);
      const reviews = segments.map((segment) => ({
        segment,
        clip: sliceAndEncodeWav(samples, sampleRate, segment.startTimeSeconds, segment.endTimeSeconds),
      }));
      setSegmentReviews(reviews);
    } catch (err) {
      setProcessingError(err instanceof Error ? err.message : String(err));
    }
  }

  const expectedCount = recordedSyllables.length;
  const detectedCount = segmentReviews?.length ?? null;
  const countsMatch = detectedCount !== null && expectedCount === detectedCount;

  const ownRecordings = previousRecordings?.filter((u) => u.isOwnRecording) ?? null;
  const otherRecordings = previousRecordings?.filter((u) => !u.isOwnRecording) ?? null;
  // Counted over what this person can actually act on. A volunteer is only sent their own
  // recordings anyway, but scoping it here as well means the warning never says "3 recordings"
  // when re-recording their own would fix one - and a curator still sees the true total.
  const divergedCount = (isCurator ? previousRecordings : ownRecordings)?.filter((u) => u.divergesFromGolden).length ?? 0;

  /** Whether what is about to be recorded already differs from the word on record.
   *
   * Byte-exact on purpose, mirroring api/src/reviewShared.ts's recordingMatchesGolden and the
   * publish scripts. An NFC-folding check here would be kinder and wrong: it would promise a
   * match the server then denies, and the speaker would find out only from the banner after
   * submitting. Better to agree with what publish does and say so up front. */
  const willDiverge =
    loaded &&
    (pronunciationText !== goldenDisplayText ||
      recordedSyllables.length !== goldenSyllables.length ||
      recordedSyllables.some((syllable, i) => syllable !== goldenSyllables[i]));

  async function submit() {
    if (!take1Blob || !take2Blob || !segmentReviews || !countsMatch) return;
    setSubmitting(true);
    setStatus(null);
    setSubmittedDiverged(false);
    try {
      await registerUtterance({
        wordId,
        takeNumber: 1,
        audio: take1Blob,
        recordedDisplayText: pronunciationText,
        recordedSyllables,
      });

      const segments = segmentReviews.map((review) => ({
        syllablePosition: review.segment.syllablePosition,
        startTimeS: review.segment.startTimeSeconds,
        endTimeS: review.segment.endTimeSeconds,
        confidence: review.segment.confidence,
        clip: review.clip,
      }));
      const registered = await registerUtterance({
        wordId,
        takeNumber: 2,
        audio: take2Blob,
        recordedDisplayText: pronunciationText,
        recordedSyllables,
        segments,
      });

      // The task is done either way - that is the fix. A recording that disagrees with the
      // record is still this speaker's work, and 0006 exists to keep it; what it is not is
      // publishable, and the outcome message has to say which of those happened rather than
      // reporting a bare success and letting the queue hand the same task back.
      //
      // `=== false`, not falsiness: an older deployment omits the field, and "not known" must
      // not render as "will not publish".
      setSubmittedDiverged(registered.matchesGolden === false);
      setStatus(registered.matchesGolden === false ? null : 'Recording submitted.');
      loadPreviousRecordings();
      onDecided?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">Couldn't load word data: {loadError}</p>;
  if (!loaded) return <p>Loading...</p>;

  return (
    <section aria-label="Audio recording" className="card">
      <h2>{pronunciationText}</h2>

      <div className="take-step" aria-label="Pronunciation">
        <h3>The tones you're about to say</h3>
        <p>
          One column per syllable, and the highlighted row is its tone — high, mid or low. Change one if you are about to
          say it differently: the recording is tied to the pronunciation you actually produce, not to this word's current
          spelling.
        </p>
        {/* Said BEFORE recording, not only afterwards. Divergence is allowed and sometimes right -
            it is the whole reason the grid is editable - but it has a consequence, and the speaker
            should be choosing it rather than discovering it. Deliberately not a block: the
            recording is still their answer. */}
        {willDiverge ? (
          <p className="warning-banner" aria-label="Pronunciation differs from the record">
            This is not the word&apos;s current spelling (<strong>{goldenDisplayText}</strong>). Recording it this way is
            fine — it is kept exactly as you say it and your task counts — but it will not be published until the
            spelling is settled or you record it again.
          </p>
        ) : null}
        {phraseText !== null ? (
          // A phrase: one grid per word, off the same composer the Add Phrase tab and the entry
          // axis use, so the tones are chosen here the way they are chosen everywhere else.
          <PhraseComposer
            id="pronunciation-phrase"
            label="The phrase, spelled as you are going to say it"
            value={phraseText}
            onChange={setPhraseText}
          />
        ) : unsplittableText === null ? (
          <ToneGrid syllables={wordSyllables} onChange={setWordSyllables} />
        ) : (
          // syllabifySpans refused this word, so there is no grid to draw and it must not be
          // silently rewritten into one. Same branch EntryReview takes, for the same reason.
          <>
            <p className="field-note" aria-label="Cannot show a tone grid">
              This word can't be broken into syllables automatically — hyphens and unusual spellings do that — so its
              tones can't be shown as a grid. Type what you are going to say instead.
            </p>
            <div className="field">
              <label htmlFor="pronunciation-text-field">Spelling</label>
              <input
                id="pronunciation-text-field"
                type="text"
                value={unsplittableText}
                onChange={(e) => setUnsplittableText(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="pronunciation-syllables-field">Syllables (comma-separated)</label>
              <input
                id="pronunciation-syllables-field"
                type="text"
                value={fallbackSyllablesText}
                onChange={(e) => {
                  setFallbackSyllablesText(e.target.value);
                  setWordSyllables(
                    e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  );
                }}
              />
            </div>
          </>
        )}
      </div>

      <div className="take-step">
        <h3>Recording 1: say the word naturally, just once</h3>
        {take1Blob ? (
          <>
            <audio controls src={URL.createObjectURL(take1Blob)} />
            <div className="btn-row">
              <button type="button" className="btn btn-secondary" onClick={() => recordTake('take1')}>
                Re-record
              </button>
            </div>
          </>
        ) : recordingStep === 'take1' ? (
          <button type="button" className="record-btn recording" onClick={() => stopTake('take1')}>
            ⏹ Stop
          </button>
        ) : (
          <button type="button" className="record-btn" onClick={() => recordTake('take1')}>
            ● Record
          </button>
        )}
      </div>

      {take1Blob ? (
        <div className="take-step">
          <h3>Recording 2: say it again, enunciating each syllable individually and cleanly</h3>
          {take2Blob ? (
            <>
              <audio controls src={URL.createObjectURL(take2Blob)} />
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" onClick={() => recordTake('take2')}>
                  Re-record
                </button>
              </div>
            </>
          ) : recordingStep === 'take2' ? (
            <button type="button" className="record-btn recording" onClick={() => stopTake('take2')}>
              ⏹ Stop
            </button>
          ) : (
            <button type="button" className="record-btn" onClick={() => recordTake('take2')}>
              ● Record
            </button>
          )}
        </div>
      ) : null}

      {recorder.error ? <p role="alert">Microphone error: {recorder.error}</p> : null}
      {processingError ? <p role="alert">Couldn't process the recording: {processingError}</p> : null}

      {segmentReviews ? (
        <div className="take-step" aria-label="Segment review">
          {countsMatch ? (
            <p className="status-banner">Detected {detectedCount} syllables, matching the expected count.</p>
          ) : (
            <p className="warning-banner">
              Detected {detectedCount} syllables, but the pronunciation above has {expectedCount}. Try re-recording
              recording 2 with a clearer pause between each syllable, or correct the syllables field above.
            </p>
          )}
          {/* The syllable and its tone, not the timings. Start/end seconds and VAD confidence are
              our diagnostics; the question the speaker is answering is "is this the right syllable,
              said the right way", and neither number helps them answer it. When the counts do not
              match there is no syllable to name for the extra clips, so those fall back to a
              position - saying nothing would be worse than saying which one is unaccounted for. */}
          <ul aria-label="Detected segments">
            {segmentReviews.map((review, i) => {
              const syllable = recordedSyllables[i];
              const tone = syllable ? toneOf(syllable) : null;
              return (
                <li key={i}>
                  {syllable ? (
                    <>
                      <strong className="segment-syllable">{syllable}</strong>
                      {tone ? <span className="badge">{tone}</span> : null}
                    </>
                  ) : (
                    <span>Clip {i + 1} — more clips than syllables</span>
                  )}
                  <br />
                  <audio controls src={URL.createObjectURL(review.clip)} />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <button type="button" className="btn btn-primary" onClick={submit} disabled={!countsMatch || submitting}>
        {submitting ? 'Submitting...' : 'Submit recording'}
      </button>
      {status ? <p role="status">{status}</p> : null}
      {/* Says what actually happened, instead of the bare "Recording submitted." this used to
          show whatever the outcome was. It opens with the task being DONE, because that is the
          behavioural change and the thing the speaker most needs to know - the old build left
          them staring at the same task with no explanation. */}
      {submittedDiverged ? (
        <p className="warning-banner" role="status" aria-label="Recording saved but not publishable">
          Recording saved, and your audio task is done. You recorded <strong>{pronunciationText}</strong>, which is not
          this word&apos;s current spelling (<strong>{goldenDisplayText}</strong>) — so it will not be published until
          the spelling is settled or you record it again. Nothing is lost: it is kept exactly as you said it.
        </p>
      ) : null}

      {/* Surfaced here rather than only in the publish script's warnings,
          because the speaker is the person who can act on it. The recordings
          are intact and still say what was said; they simply no longer describe
          this word's current spelling, so the game would omit them. */}
      {divergedCount > 0 ? (
        <p className="warning-banner" aria-label="Recording divergence warning">
          {divergedCount === 1
            ? '1 existing recording was made under a different pronunciation'
            : `${divergedCount} existing recordings were made under a different pronunciation`}{' '}
          than this word&apos;s current spelling ({goldenDisplayText}). They are preserved exactly as recorded, but will
          not be published until re-recorded.
        </p>
      ) : null}

      <div className="take-step" aria-label="Your recordings">
        <h3>Your recordings</h3>
        {previousRecordingsError ? (
          <p role="alert">Couldn't load your recordings: {previousRecordingsError}</p>
        ) : ownRecordings === null ? (
          <p>Loading your recordings...</p>
        ) : ownRecordings.length === 0 ? (
          <p>You haven't recorded this word yet.</p>
        ) : (
          <ul aria-label="Your recordings by take">
            {ownRecordings.map((u) => (
              <UtteranceRow key={u.utteranceId} u={u} showSpeakerName={false} />
            ))}
          </ul>
        )}
      </div>

      {/* Curator-only, for the reasons in this file's header: a volunteer recording a word must
          not hear someone else say it first, and the API does not send it to them either. Kept
          clearly separate from "Your recordings" above rather than blended, so it can never read
          as a single "someone has done this" signal. */}
      {isCurator ? (
        <div className="take-step" aria-label="Other speakers' recordings">
          <h3>Other speakers' recordings</h3>
          {previousRecordingsError ? null : otherRecordings === null ? null : otherRecordings.length === 0 ? (
            <p>No other speakers have recorded this word yet.</p>
          ) : (
            <ul aria-label="Other speakers' recordings by take">
              {otherRecordings.map((u) => (
                <UtteranceRow key={u.utteranceId} u={u} showSpeakerName={true} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

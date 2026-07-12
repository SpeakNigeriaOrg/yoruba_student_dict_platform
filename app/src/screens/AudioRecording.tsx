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

import { useEffect, useState } from 'react';
import { decodeToSamples } from '../audio/decodeToSamples.js';
import { sliceAndEncodeWav } from '../audio/encodeWav.js';
import { segmentSyllables, type SyllableSegment } from '../audio/segmentSyllables.js';
import { useAudioRecorder } from '../audio/useAudioRecorder.js';
import { base64ToAudioUrl, getSpellingReview, listUtterances, registerUtterance, type UtteranceSummary } from '../api.js';

export interface AudioRecordingProps {
  wordId: string;
}

interface SegmentReview {
  segment: SyllableSegment;
  clip: Blob;
}

export function AudioRecording({ wordId }: AudioRecordingProps) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [pronunciationText, setPronunciationText] = useState('');
  const [pronunciationSyllablesText, setPronunciationSyllablesText] = useState('');
  const recordedSyllables = pronunciationSyllablesText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const recorder = useAudioRecorder();
  const [take1Blob, setTake1Blob] = useState<Blob | null>(null);
  const [take2Blob, setTake2Blob] = useState<Blob | null>(null);
  const [recordingStep, setRecordingStep] = useState<'take1' | 'take2' | null>(null);

  const [segmentReviews, setSegmentReviews] = useState<SegmentReview[] | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
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
    setPreviousRecordings(null);
    setPreviousRecordingsError(null);
    getSpellingReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setPronunciationText(result.displayText);
        setPronunciationSyllablesText(result.syllables.join(','));
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

  async function submit() {
    if (!take1Blob || !take2Blob || !segmentReviews || !countsMatch) return;
    setSubmitting(true);
    setStatus(null);
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
      await registerUtterance({
        wordId,
        takeNumber: 2,
        audio: take2Blob,
        recordedDisplayText: pronunciationText,
        recordedSyllables,
        segments,
      });

      setStatus('Recording submitted.');
      loadPreviousRecordings();
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
        <h3>Pronunciation you're recording</h3>
        <p>
          Edit these if you're recording a different spelling or tone than what's shown - the recording is tied to
          the pronunciation you actually say, not necessarily this word's current spelling.
        </p>
        <div className="field">
          <label htmlFor="pronunciation-text-field">Spelling</label>
          <input
            id="pronunciation-text-field"
            type="text"
            value={pronunciationText}
            onChange={(e) => setPronunciationText(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pronunciation-syllables-field">Syllables (comma-separated)</label>
          <input
            id="pronunciation-syllables-field"
            type="text"
            value={pronunciationSyllablesText}
            onChange={(e) => setPronunciationSyllablesText(e.target.value)}
          />
        </div>
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
          <ul aria-label="Detected segments">
            {segmentReviews.map((review, i) => (
              <li key={i}>
                Syllable {i + 1} ({review.segment.startTimeSeconds.toFixed(2)}s - {review.segment.endTimeSeconds.toFixed(2)}s,
                confidence {review.segment.confidence.toFixed(2)})
                <br />
                <audio controls src={URL.createObjectURL(review.clip)} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button type="button" className="btn btn-primary" onClick={submit} disabled={!countsMatch || submitting}>
        {submitting ? 'Submitting...' : 'Submit recording'}
      </button>
      {status ? <p role="status">{status}</p> : null}

      <div className="take-step" aria-label="Previous recordings">
        <h3>Previous recordings</h3>
        {previousRecordingsError ? (
          <p role="alert">Couldn't load previous recordings: {previousRecordingsError}</p>
        ) : previousRecordings === null ? (
          <p>Loading previous recordings...</p>
        ) : previousRecordings.length === 0 ? (
          <p>No recordings yet for this word.</p>
        ) : (
          <ul aria-label="Recordings by speaker">
            {previousRecordings.map((u) => (
              <li key={u.utteranceId}>
                <strong>{u.speakerDisplayName}</strong> - take {u.takeNumber} ({u.status}) - recorded as{' '}
                <em>
                  {u.recordedDisplayText} ({u.recordedSyllables.join(' · ')})
                </em>
                {u.audioDataBase64 ? (
                  <>
                    <br />
                    <audio controls src={base64ToAudioUrl(u.audioDataBase64)} />
                  </>
                ) : null}
                {u.segments.length > 0 ? (
                  <ul aria-label={`${u.speakerDisplayName} take ${u.takeNumber} segments`}>
                    {u.segments.map((seg) => (
                      <li key={seg.syllablePosition}>
                        Syllable {seg.syllablePosition + 1} ({seg.syllableText})
                        <br />
                        <audio controls src={base64ToAudioUrl(seg.audioDataBase64)} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

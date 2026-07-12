// screens/AudioRecording.tsx
//
// The 4th axis tab: records the two-take protocol (see
// REMOTE_ACCESS_DISCUSSION.md's "Audio pipeline" section) - take 1, a
// clean whole-word recording; take 2, the same word spoken with
// deliberate pauses between syllables, which gets decoded, segmented
// (segmentSyllables.ts), and sliced into one WAV clip per detected
// syllable for review before submitting.
//
// Real backend (issueUploadSasToken/registerUtterance), but genuinely
// unverified end-to-end without a real Azure Storage Account existing -
// stated plainly, not glossed over, same as this project's other
// infra-gated pieces.

import { useEffect, useState } from 'react';
import { decodeToSamples } from '../audio/decodeToSamples.js';
import { sliceAndEncodeWav } from '../audio/encodeWav.js';
import { segmentSyllables, type SyllableSegment } from '../audio/segmentSyllables.js';
import { useAudioRecorder } from '../audio/useAudioRecorder.js';
import { getSpellingReview, getUploadSasToken, registerUtterance, uploadBlob } from '../api.js';

export interface AudioRecordingProps {
  wordId: string;
}

interface SegmentReview {
  segment: SyllableSegment;
  clip: Blob;
}

export function AudioRecording({ wordId }: AudioRecordingProps) {
  const [displayText, setDisplayText] = useState<string | null>(null);
  const [expectedSyllables, setExpectedSyllables] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const recorder = useAudioRecorder();
  const [take1Blob, setTake1Blob] = useState<Blob | null>(null);
  const [take2Blob, setTake2Blob] = useState<Blob | null>(null);
  const [recordingStep, setRecordingStep] = useState<'take1' | 'take2' | null>(null);

  const [segmentReviews, setSegmentReviews] = useState<SegmentReview[] | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDisplayText(null);
    setExpectedSyllables(null);
    setTake1Blob(null);
    setTake2Blob(null);
    setSegmentReviews(null);
    setStatus(null);
    getSpellingReview(wordId)
      .then((result) => {
        if (cancelled) return;
        setDisplayText(result.displayText);
        setExpectedSyllables(result.syllables);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function recordTake(take: 'take1' | 'take2') {
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

  const expectedCount = expectedSyllables?.length ?? null;
  const detectedCount = segmentReviews?.length ?? null;
  const countsMatch = expectedCount !== null && detectedCount !== null && expectedCount === detectedCount;

  async function submit() {
    if (!take1Blob || !take2Blob || !segmentReviews || !countsMatch) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const token = await getUploadSasToken(wordId);

      const take1Path = await uploadBlob(token, 'take1.webm', take1Blob);
      await registerUtterance({ wordId, takeNumber: 1, blobPath: take1Path });

      const take2Path = await uploadBlob(token, 'take2.webm', take2Blob);
      const segments = [];
      for (const [i, review] of segmentReviews.entries()) {
        const clipPath = await uploadBlob(token, `segment-${i}.wav`, review.clip);
        segments.push({
          syllablePosition: review.segment.syllablePosition,
          startTimeS: review.segment.startTimeSeconds,
          endTimeS: review.segment.endTimeSeconds,
          confidence: review.segment.confidence,
          blobPath: clipPath,
        });
      }
      await registerUtterance({ wordId, takeNumber: 2, blobPath: take2Path, segments });

      setStatus('Recording submitted.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">Couldn't load word data: {loadError}</p>;
  if (!displayText || !expectedSyllables) return <p>Loading...</p>;

  return (
    <section aria-label="Audio recording" className="card">
      <h2>{displayText}</h2>
      <p>Expected syllables: {expectedSyllables.length}</p>

      <div className="take-step">
        <h3>Take 1: say the whole word clearly</h3>
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
            ● Record take 1
          </button>
        )}
      </div>

      {take1Blob ? (
        <div className="take-step">
          <h3>Take 2: say each syllable separately, with a pause between</h3>
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
              ● Record take 2
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
              Detected {detectedCount} syllables, but this word has {expectedCount}. Try re-recording take 2 with a
              clearer pause between each syllable.
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
    </section>
  );
}

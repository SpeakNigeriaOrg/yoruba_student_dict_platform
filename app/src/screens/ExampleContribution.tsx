// screens/ExampleContribution.tsx
//
// The fourth axis: show the word in use. One example - written correctly, translated, and
// spoken at natural pace.
//
// ---------------------------------------------------------------------------
// Why the type is chosen first
// ---------------------------------------------------------------------------
// The three kinds ARE the instructions. A volunteer asked to "give an example" has to
// invent the genre as well as the content; asked to pick between "a word built from this
// one", "a phrase built from this one" and "a short phrase using it", they are shown what
// counts before they start. It is one tap, and it records something that cannot be
// recovered afterwards: `abo adìyẹ` is a derived TERM the dictionary may eventually want as
// its own entry, `Ọ̀pọ̀lọ́ ń fò` is an illustration, and once the type is gone both are just
// multi-word strings.
//
// ---------------------------------------------------------------------------
// All three parts, or nothing
// ---------------------------------------------------------------------------
// An example without audio is not an example - hearing the word used is the point. So the
// phrase, the translation and the recording are submitted together, the same discipline the
// entry axis applies to spelling and meaning. There is no half-saved example.
//
// ---------------------------------------------------------------------------
// Others' examples come AFTER yours
// ---------------------------------------------------------------------------
// Deliberately not before. Reading someone else's example first anchors a contributor into
// paraphrasing it rather than thinking of their own, and the whole value of this axis is
// that several people illustrate a word differently. AudioRecording shows other speakers'
// recordings the same way, for the same reason.

import { useEffect, useState } from 'react';
import { decodeToSamples } from '../audio/decodeToSamples.js';
import { encodeWavFromPCM } from '../audio/encodeWav.js';
import { useAudioRecorder } from '../audio/useAudioRecorder.js';
import { base64ToAudioUrl, getEntryReview, getExamples, submitExample, type ExampleSummary, type ExampleType } from '../api.js';
import { PhraseComposer } from './PhraseComposer.js';

export interface ExampleContributionProps {
  wordId: string;
  /** Called after a successful submit, so the task queue can advance. */
  onDecided?: () => void;
}

const KINDS: Array<{ type: ExampleType; label: string; hint: string }> = [
  { type: 'derived_term', label: 'A word built from this one', hint: 'ilé → kúulé' },
  { type: 'derived_phrase', label: 'A phrase built from this one', hint: 'adìyẹ → abo adìyẹ (hen)' },
  { type: 'usage_phrase', label: 'A short phrase using it', hint: 'Ọ̀pọ̀lọ́ ń fò (the frog hops)' },
];

const KIND_LABEL: Record<ExampleType, string> = {
  derived_term: 'derived word',
  derived_phrase: 'derived phrase',
  usage_phrase: 'phrase',
};

export function ExampleContribution({ wordId, onDecided }: ExampleContributionProps) {
  const [displayText, setDisplayText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [kind, setKind] = useState<ExampleType | null>(null);
  const [phrase, setPhrase] = useState('');
  const [translation, setTranslation] = useState('');
  const [audio, setAudio] = useState<Blob | null>(null);
  const [encodeError, setEncodeError] = useState<string | null>(null);

  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [others, setOthers] = useState<ExampleSummary[] | null>(null);

  const recorder = useAudioRecorder();

  useEffect(() => {
    let cancelled = false;
    setDisplayText(null);
    setLoadError(null);
    setKind(null);
    setPhrase('');
    setTranslation('');
    setAudio(null);
    setSubmitted(false);
    setOthers(null);
    setStatus(null);
    getEntryReview(wordId)
      .then((review) => {
        if (!cancelled) setDisplayText(review.displayText);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function stopRecording() {
    const blob = await recorder.stop();
    setEncodeError(null);
    try {
      // Re-encoded to WAV rather than stored as the browser's webm/opus, matching what
      // registerUtterance already stores - one audio format in the database. NOT segmented
      // per syllable: that exists to harvest game audio from a word's pronunciation, and a
      // phrase at natural pace is not that.
      const { samples, sampleRate } = await decodeToSamples(blob);
      setAudio(encodeWavFromPCM(samples, sampleRate));
    } catch (err) {
      setEncodeError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit() {
    if (!kind || !phrase.trim() || !translation.trim() || !audio) return;
    setSubmitting(true);
    setStatus(null);
    try {
      await submitExample(wordId, { exampleType: kind, exampleText: phrase.trim(), translation: translation.trim(), audio });
      setSubmitted(true);
      setStatus('Thanks - your example is recorded.');
      // Only now: see the file header on why others come after.
      setOthers(await getExamples(wordId).catch(() => []));
      onDecided?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError)
    return (
      <p role="alert" className="error-banner">
        Couldn't load this word: {loadError}
      </p>
    );
  if (displayText === null) return <p>Loading...</p>;

  const ready = Boolean(kind) && phrase.trim().length > 0 && translation.trim().length > 0 && audio !== null;

  return (
    <section aria-label="Example of use" className={`card${submitted ? ' decided' : ''}`}>
      <h2>{displayText}</h2>
      <p className="field-note">
        Show this word being used. One example is enough - whichever kind is easiest for you.
      </p>

      <h3>What kind of example?</h3>
      <div className="btn-row" role="group" aria-label="Kind of example">
        {KINDS.map(({ type, label, hint }) => (
          <button
            key={type}
            type="button"
            className={`btn example-kind ${kind === type ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={kind === type}
            onClick={() => setKind(type)}
          >
            <span className="example-kind-label">{label}</span>
            <span className="example-kind-hint">{hint}</span>
          </button>
        ))}
      </div>

      {kind ? (
        <>
          <h3>Write it</h3>
          <PhraseComposer
            id="example-phrase"
            value={phrase}
            onChange={setPhrase}
            label={`The ${KIND_LABEL[kind]}, in Yoruba`}
            placeholder="e.g. abo adiye"
          />

          <div className="field">
            <label htmlFor="example-translation-field">What does it mean in English?</label>
            <input
              id="example-translation-field"
              type="text"
              value={translation}
              onChange={(e) => setTranslation(e.target.value)}
            />
          </div>

          <h3>Say it out loud</h3>
          <p className="field-note">
            Read it at a natural pace, the way you would say it to someone - not slowly or one syllable at a time.
          </p>
          <div className="btn-row">
            {recorder.isRecording ? (
              <button type="button" className="record-btn recording" onClick={() => void stopRecording()}>
                Stop
              </button>
            ) : (
              <button type="button" className="record-btn" onClick={() => void recorder.start()}>
                {audio ? 'Record again' : 'Record'}
              </button>
            )}
          </div>
          {recorder.error ? (
            <p role="alert" className="error-banner">
              {recorder.error}
            </p>
          ) : null}
          {encodeError ? (
            <p role="alert" className="error-banner">
              Couldn't process that recording: {encodeError}
            </p>
          ) : null}
          {audio ? <audio controls src={URL.createObjectURL(audio)} aria-label="Your recording" /> : null}

          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!ready || submitting}>
            {submitting ? 'Submitting...' : 'Submit example'}
          </button>
          {!ready ? (
            <p className="field-note">
              An example needs all three: the phrase, what it means, and hearing you say it.
            </p>
          ) : null}
        </>
      ) : null}

      {status ? (
        <p role="status" className="status-banner">
          {status}
        </p>
      ) : null}

      {submitted && others ? (
        <div aria-label="Other examples">
          <h3>Other examples for this word</h3>
          {others.filter((e) => !e.isOwn).length === 0 ? (
            <p>Nobody else has given one yet - yours is the first.</p>
          ) : (
            <ul className="card-list">
              {others
                .filter((e) => !e.isOwn)
                .map((e) => (
                  <li key={e.exampleId} className="card-row">
                    <p>
                      <strong>{e.exampleText}</strong> - {e.translation}
                    </p>
                    <p className="field-note">
                      {KIND_LABEL[e.exampleType]}, from {e.contributorLabel}
                    </p>
                    <audio controls src={base64ToAudioUrl(e.audioDataBase64)} />
                  </li>
                ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

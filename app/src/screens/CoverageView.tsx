// screens/CoverageView.tsx
//
// What the game can actually play, per speaker.
//
// Every number here was already computed - by scripts/publishToR2.mjs and
// scripts/exportGameContent.mjs, and then printed to a console. The second of those says in
// its own header that no curator-visible coverage view exists. This is it.
//
// The organising choice is per SPEAKER, and it is the whole point. A level plays one voice,
// so syllables covered by three different people cover nothing: three speakers at 60% each
// can leave zero words playable, and a corpus-wide percentage would report that as good
// progress.

import { useEffect, useState } from 'react';
import { getCoverageReport, type CoverageReport } from '../api.js';

export function CoverageView() {
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllSyllables, setShowAllSyllables] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCoverageReport()
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load coverage: {error}
      </p>
    );
  if (!report) return <p>Loading coverage...</p>;

  const thin = report.syllables.filter((s) => s.recordings === 0 || s.speakersWithDuplicates > 0);
  const syllables = showAllSyllables ? report.syllables : thin;

  return (
    <section aria-label="Coverage">
      <h3>What each voice can carry</h3>
      <p className="field-note">
        A level plays one voice, so a word counts for a speaker only if that same speaker recorded the word, every one
        of its syllables, and the word has an image. A speaker below {report.minLevelWords} playable words generates no
        levels at all.
      </p>
      <div className="table-scroll">
        <table className="survey">
          <thead>
            <tr>
              <th>Voice</th>
              <th>Words recorded</th>
              <th>All syllables too</th>
              <th>Playable (with image)</th>
              <th>Stale</th>
              <th>Rights</th>
            </tr>
          </thead>
          <tbody>
            {report.speakers.map((s) => (
              <tr key={s.speakerId}>
                <td>{s.displayName}</td>
                <td>
                  <span className={`figure${s.wordsRecorded === 0 ? ' zero' : ''}`}>{s.wordsRecorded}</span>
                </td>
                <td>
                  <span className={`figure${s.wordsFullyCovered === 0 ? ' zero' : ''}`}>{s.wordsFullyCovered}</span>
                </td>
                <td>
                  <span className={`figure${s.wordsPlayable === 0 ? ' zero' : ''}`}>{s.wordsPlayable}</span>{' '}
                  {s.meetsLevelMinimum ? null : <span className="state provisional">below the level minimum</span>}
                </td>
                <td>
                  <span className={`figure${s.staleRecordings > 0 ? ' warn' : ' zero'}`}>{s.staleRecordings}</span>
                </td>
                <td>
                  <span className={`state ${s.releaseState === 'agreed' ? 'golden' : 'provisional'}`}>
                    {s.releaseState}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Tone patterns</h3>
      <p className="field-note">
        Levels can be built around a shared high/mid/low shape, but only where one speaker has{' '}
        {report.minTonePatternWords} playable words of that shape. Nothing has ever surfaced this, so it is the least
        exploited way the corpus could be taught.
      </p>
      <div className="table-scroll">
        <table className="survey">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Words in the dictionary</th>
              <th>Voices that could carry a level</th>
            </tr>
          </thead>
          <tbody>
            {report.tonePatterns.slice(0, 20).map((t) => (
              <tr key={t.pattern}>
                <td className="word-id">{t.pattern}</td>
                <td>
                  <span className="figure">{t.wordsInCorpus}</span>
                </td>
                <td>
                  <span className={`figure${t.speakersWithEnough === 0 ? ' zero' : ''}`}>{t.speakersWithEnough}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Syllable stock</h3>
      <p className="field-note">
        {showAllSyllables
          ? 'Every syllable the dictionary needs.'
          : 'Syllables nobody has recorded, and syllables one speaker recorded more than once.'}{' '}
        A duplicate is not harmless: the publish step takes the first row it finds with no tiebreak, so which take
        ships is arbitrary.{' '}
        <button type="button" className="btn btn-link" onClick={() => setShowAllSyllables((v) => !v)}>
          {showAllSyllables ? 'Show only the gaps' : 'Show all'}
        </button>
      </p>
      {syllables.length === 0 ? (
        <p>Every syllable is recorded once by each speaker who recorded it. Nothing to resolve.</p>
      ) : (
        <div className="table-scroll">
          <table className="survey">
            <thead>
              <tr>
                <th>Syllable</th>
                <th>Words needing it</th>
                <th>Recordings</th>
                <th>Voices</th>
                <th>Voices with more than one take</th>
              </tr>
            </thead>
            <tbody>
              {syllables.map((s) => (
                <tr key={s.syllable}>
                  <td>{s.syllable}</td>
                  <td>
                    <span className="figure">{s.wordsUsingIt}</span>
                  </td>
                  <td>
                    <span className={`figure${s.recordings === 0 ? ' zero' : ''}`}>{s.recordings}</span>
                  </td>
                  <td>
                    <span className={`figure${s.speakers === 0 ? ' zero' : ''}`}>{s.speakers}</span>
                  </td>
                  <td>
                    <span className={`figure${s.speakersWithDuplicates > 0 ? ' warn' : ' zero'}`}>
                      {s.speakersWithDuplicates}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Said rather than quietly omitted. */}
      <p className="field-note">
        Two things the publish scripts report that cannot be computed here: per-theme coverage, because the themes live
        in another repository's <span className="word-id">sessions_source.json</span>; and orphaned files in the
        published bucket, which needs the bucket's own credentials. Both stay with{' '}
        <span className="word-id">publishToR2.mjs</span>.
      </p>
    </section>
  );
}

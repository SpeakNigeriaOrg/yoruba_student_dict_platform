// screens/WordDossier.tsx
//
// Everything the system holds about one word, on one page.
//
// This is the "closer to the raw tables" view, arranged by the thing the tables are all
// about rather than by table. Three of its sections show data that has never been readable
// from anywhere in the app, each preserved by a migration that then had no consumer:
// superseded contributions (0013's belief history), the upstream pin itself (0014), and
// 0011's archive of pre-merge decisions.
//
// Deliberately read-only. Working ON a word is the review screens; this is reading it.

import { useEffect, useState } from 'react';
import { AGREEMENT_THRESHOLD } from '@yoruba-student-dict-platform/shared';
import {
  confirmConsensus,
  excludeContribution,
  excludeExample,
  getConsensus,
  getWordDossier,
  wordImageUrl,
  type ConsensusGroup,
  type DossierContribution,
  type DossierExample,
  type DossierRecording,
  type WordDossier as Dossier,
} from '../api.js';
import { CitationMark } from './StateMarks.js';

function when(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

export interface WordDossierProps {
  wordId: string;
  onOpenWord: (wordId: string) => void;
  onOpenDossier: (wordId: string) => void;
}

export function WordDossier({ wordId, onOpenWord, onOpenDossier }: WordDossierProps) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDossier(null);
    setError(null);
    getWordDossier(wordId)
      .then((d) => {
        if (!cancelled) setDossier(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [wordId, reloadToken]);

  const reload = () => setReloadToken((n) => n + 1);

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load {wordId}: {error}
      </p>
    );
  if (!dossier) return <p>Loading {wordId}...</p>;

  return (
    <section aria-label="Word dossier">
      <h2>{dossier.displayText}</h2>
      <p className="word-id">{dossier.wordId}</p>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={() => onOpenWord(dossier.wordId)}>
          Review this word
        </button>
      </div>
      <p className="field-note">
        Reviewing records <em>your own answer</em>, the same as anyone else's. Setting the record is below, and it is a
        different act.
      </p>

      <DecideSection wordId={dossier.wordId} />

      <div className="dossier-grid">
        <div className="dossier-section" aria-label="Record">
          <h3>The record</h3>
          <dl>
            <dt>Spelling</dt>
            <dd>{dossier.displayText}</dd>
            <dt>Syllables</dt>
            <dd>{dossier.syllables.join(' · ')}</dd>
            <dt>Definition</dt>
            <dd>{dossier.definition ?? '(none)'}</dd>
            <dt>Type</dt>
            <dd>{dossier.entryType ?? 'word'}</dd>
            {/* 0018's overrides. Written at creation and, until this screen, readable only
                by an offline export script - so nobody could check them. */}
            <dt>Part of speech</dt>
            <dd>{dossier.pos ?? '(from the pin)'}</dd>
            <dt>English gloss</dt>
            <dd>{dossier.englishGloss ?? '(from the pin)'}</dd>
            <dt>Etymid label</dt>
            <dd>{dossier.etymidLabel ?? '(derived from the word_id)'}</dd>
            <dt>Last changed</dt>
            <dd>
              {when(dossier.updatedAt)}
              {dossier.updatedByEmail ? ` by ${dossier.updatedByEmail}` : ''}
            </dd>
          </dl>
        </div>

        <div className="dossier-section" aria-label="Wiktionary citation">
          <h3>Wiktionary</h3>
          <dl>
            <dt>State</dt>
            <dd>
              <CitationMark state={dossier.citation} reason={dossier.exemptReason} />
            </dd>
            {dossier.citedEntryId ? (
              <>
                <dt>Entry id</dt>
                <dd className="word-id">{dossier.citedEntryId}</dd>
              </>
            ) : null}
            {dossier.exemptReason ? (
              <>
                <dt>Exempt because</dt>
                <dd>{dossier.exemptReason}</dd>
              </>
            ) : null}
            <dt>Pinned</dt>
            <dd>
              {when(dossier.pinnedAt)}
              {dossier.pinnedByEmail ? ` by ${dossier.pinnedByEmail}` : ''}
            </dd>
          </dl>
          {/* The copy taken when a human validated the citation. It is what the entry axis
              reasons from, and it has only ever been visible as a drift diff. */}
          {dossier.pin && Object.keys(dossier.pin as object).length > 0 ? (
            <>
              <p className="field-note">What Wiktionary said when this was validated:</p>
              <pre>{JSON.stringify(dossier.pin, null, 2)}</pre>
            </>
          ) : (
            <p className="field-note">No pinned copy.</p>
          )}
        </div>

        <div className="dossier-section" aria-label="Composition">
          <h3>Composition</h3>
          {dossier.components.length === 0 ? (
            <p className="field-note">Atomic - no recorded parts.</p>
          ) : (
            <ul className="plain-list">
              {dossier.components.map((c) => (
                <li key={`${c.position}-${c.wordId}`}>
                  <button type="button" className="btn btn-link" onClick={() => onOpenDossier(c.wordId)}>
                    {c.displayText}
                  </button>{' '}
                  <span className="word-id">{c.wordId}</span>
                </li>
              ))}
            </ul>
          )}
          <h3>Used as a part of</h3>
          {dossier.usedAsComponentOf.length === 0 ? (
            <p className="field-note">Nothing is built from this word.</p>
          ) : (
            <ul className="plain-list">
              {dossier.usedAsComponentOf.map((c) => (
                <li key={c.wordId}>
                  <button type="button" className="btn btn-link" onClick={() => onOpenDossier(c.wordId)}>
                    {c.displayText}
                  </button>{' '}
                  <span className="word-id">{c.wordId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="dossier-section" aria-label="Decisions">
          <h3>Decisions</h3>
          {dossier.decisions.length === 0 ? (
            <p className="field-note">Nothing has been decided on this word.</p>
          ) : (
            <ul className="plain-list">
              {dossier.decisions.map((d, i) => (
                <li key={`${d.axis}-${i}`} className={d.archived ? 'set-aside' : undefined}>
                  <strong>{d.axis}</strong>
                  {d.archived ? ' (archived by the 0011 axis merge)' : ''} — {when(d.decidedAt)}
                  {d.decidedByEmail ? ` by ${d.decidedByEmail}` : ''}
                  {d.note ? <div className="field-note">{d.note}</div> : null}
                  <pre>{JSON.stringify(d.decision, null, 2)}</pre>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="dossier-section" aria-label="Contributions">
          <h3>Contributions</h3>
          {dossier.contributions.length === 0 ? (
            <p className="field-note">Nobody has offered an opinion on this word.</p>
          ) : (
            <ul className="plain-list">
              {dossier.contributions.map((c) => (
                <ContributionRow key={c.contributionId} contribution={c} onExcluded={reload} />
              ))}
            </ul>
          )}
          <p className="field-note">
            Superseded and excluded entries are shown. They are kept deliberately - a change of mind is evidence too -
            and this is the first screen that can read them back.
          </p>
        </div>

        <div className="dossier-section" aria-label="Recordings">
          <h3>Recordings</h3>
          {dossier.recordings.length === 0 ? (
            <p className="field-note">Nobody has recorded this word.</p>
          ) : (
            <ul className="plain-list">
              {dossier.recordings.map((r) => (
                <RecordingRow key={r.utteranceId} recording={r} />
              ))}
            </ul>
          )}
        </div>

        <div className="dossier-section" aria-label="Examples">
          <h3>Examples</h3>
          {dossier.examples.length === 0 ? (
            <p className="field-note">No examples yet.</p>
          ) : (
            <ul className="plain-list">
              {dossier.examples.map((e) => (
                <ExampleRow key={e.exampleId} example={e} onExcluded={reload} />
              ))}
            </ul>
          )}
        </div>

        <div className="dossier-section" aria-label="Images">
          <h3>Images</h3>
          {dossier.images.length === 0 ? (
            <p className="field-note">
              No image. This is a hard gate on the game export - a word is never shown with a placeholder standing in
              for its picture.
            </p>
          ) : (
            <div className="dossier-images">
              {dossier.images.map((img) => (
                <figure key={img.imageId} style={{ margin: 0 }}>
                  <img src={wordImageUrl(img.imageId)} alt={`${dossier.displayText}, ${img.artStyle}`} />
                  <figcaption className="field-note">
                    {img.artStyle} #{img.variantNumber}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>

        <div className="dossier-section" aria-label="Assignments">
          <h3>Assigned to</h3>
          {dossier.assignees.length === 0 ? (
            <p className="field-note">Nobody.</p>
          ) : (
            <ul className="plain-list">
              {dossier.assignees.map((a) => (
                <li key={a.email}>
                  {a.displayName ?? a.email} <span className="field-note">since {when(a.assignedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** One vote, with the one moderation action the tally has ever needed and never had.
 *
 * excludeContribution accepts any active row and always has - its own header names spam, a
 * duplicate account and test data as the cases - but the only call site in the app was
 * hardcoded to declining a requested WORD. So a bad entry or etymology vote could be seen
 * in a tally and not removed from it. */
function ContributionRow({ contribution, onExcluded }: { contribution: DossierContribution; onExcluded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setAside = contribution.status !== 'active';

  async function exclude() {
    const reason = window.prompt('Why is this being removed from the tally?');
    if (!reason?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await excludeContribution(contribution.contributionId, reason.trim());
      onExcluded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={setAside ? 'set-aside' : undefined}>
      <strong>{contribution.axis}</strong> · <span className="state none">{contribution.status}</span> ·{' '}
      {contribution.submittedByEmail} · {when(contribution.submittedAt)}
      {contribution.note ? <div className="field-note">{contribution.note}</div> : null}
      {contribution.excludedReason ? <div className="field-note">Excluded: {contribution.excludedReason}</div> : null}
      <pre>{JSON.stringify(contribution.resolvedValue ?? contribution.proposedValue, null, 2)}</pre>
      {contribution.status === 'active' ? (
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void exclude()}>
          Remove from the tally
        </button>
      ) : null}
      {error ? <p role="alert" className="field-note">{error}</p> : null}
    </li>
  );
}

/** An example, and the moderation 0015 designed columns for and never wired up. */
function ExampleRow({ example, onExcluded }: { example: DossierExample; onExcluded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exclude() {
    const reason = window.prompt('Why is this example being removed?');
    if (!reason?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await excludeExample(example.exampleId, reason.trim());
      onExcluded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={example.excludedReason ? 'set-aside' : undefined}>
      <strong>{example.exampleText}</strong> — {example.translation}
      <div className="field-note">
        {example.exampleType} · {example.authorEmail} · rights: {example.releaseState} · {when(example.submittedAt)}
      </div>
      {/* Computed since 0015 and shown by nothing until now. */}
      {example.wordTextChanged ? (
        <div className="field-note">
          <span className="state provisional">recorded as {example.recordedWordText}</span> — the word has been
          respelled since.
        </div>
      ) : null}
      {example.excludedReason ? (
        <div className="field-note">Excluded: {example.excludedReason}</div>
      ) : (
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void exclude()}>
          Remove this example
        </button>
      )}
      {error ? <p role="alert" className="field-note">{error}</p> : null}
    </li>
  );
}

function RecordingRow({ recording }: { recording: DossierRecording }) {
  return (
    <li>
      <strong>{recording.speakerName}</strong> · take {recording.takeNumber} ·{' '}
      {recording.matchesGolden ? (
        <span className="state golden">matches</span>
      ) : (
        <span className="state provisional">no longer matches</span>
      )}
      <div className="field-note">
        said as “{recording.recordedDisplayText}” ({recording.recordedSyllables.join(' · ')}) ·{' '}
        {recording.segmentCount} clip{recording.segmentCount === 1 ? '' : 's'}
        {/* The segmenter's own confidence. It produces this per clip and nothing has ever
            read it, which is why the question it was meant to answer - is the simple
            segmenter good enough - has no data behind it. */}
        {recording.lowestSegmentConfidence !== null
          ? ` · lowest confidence ${recording.lowestSegmentConfidence.toFixed(2)}`
          : ''}
        {' · '}rights: {recording.releaseState} · {when(recording.recordedAt)}
      </div>
    </li>
  );
}

/** Where the golden record actually gets set.
 *
 * The two levels are separated by PLACE, and this is the place. On the review screens
 * everyone - curators included - records an opinion, because a curator's knowledge of a word
 * is not better than anyone else's. Here a curator reads what everybody said and decides,
 * which is a different act and deserves to look like one.
 *
 * It goes through confirmConsensus rather than the direct decision endpoints, so the same
 * safeguards apply as in the bulk queue: the server re-derives the winner and refuses the
 * item if the tally has moved since this screen loaded (expectedFingerprint). A curator
 * ratifying their own lone vote is allowed and is the ordinary one-person case - it just
 * takes the deliberate second act rather than happening as a side effect of answering.
 */
function DecideSection({ wordId }: { wordId: string }) {
  const [groups, setGroups] = useState<ConsensusGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function load() {
    // Every bucket, unlike the queue's actionable default: on a dossier, "this is settled and
    // here is what was agreed" is worth reading.
    getConsensus({ wordId, buckets: ['contested', 'dissent_on_golden', 'ready', 'single', 'golden', 'none'] })
      .then(setGroups)
      .catch(() => setGroups([]));
  }

  useEffect(load, [wordId]);

  async function decide(group: ConsensusGroup, fingerprint: string) {
    setBusy(true);
    setStatus(null);
    try {
      const result = await confirmConsensus([{ wordId: group.wordId, axis: group.axis, expectedFingerprint: fingerprint }]);
      const skipped = result.skipped?.[0];
      setStatus(skipped ? `Not applied: ${skipped.reason.replace(/_/g, ' ')}.` : `The record now says this for ${group.axis}.`);
      load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!groups) return null;

  return (
    <section className="dossier-section" aria-label="Set the record">
      <h3>Set the record</h3>
      {groups.length === 0 ? (
        <p className="field-note">
          Nobody has answered either axis on this word yet, so there is nothing to ratify. Review it first.
        </p>
      ) : (
        groups.map((g) => (
          <div key={`${g.wordId}:${g.axis}`}>
            <p>
              <strong>{g.axis}</strong>{' '}
              <span className={`state ${g.summary.bucket === 'golden' ? 'golden' : g.summary.bucket === 'contested' || g.summary.bucket === 'dissent_on_golden' ? 'blocked' : 'provisional'}`}>
                {g.summary.bucket.replace(/_/g, ' ')}
              </span>{' '}
              <span className="field-note">
                {g.summary.totalVotes} answer{g.summary.totalVotes === 1 ? '' : 's'}
                {g.decidedAt ? ` · decided ${when(g.decidedAt)}${g.decidedByEmail ? ` by ${g.decidedByEmail}` : ''}` : ''}
              </span>
            </p>
            {g.summary.isContested ? (
              <p className="field-note">
                Answers differ on {g.summary.differingFields.join(', ') || 'the outcome'}. Choosing one settles it.
              </p>
            ) : null}
            <ul className="plain-list claim-list">
              {g.summary.tally.map((claim) => (
                <li key={claim.fingerprint} className="claim">
                  <span className="claim-votes">
                    {claim.count} of {g.summary.totalVotes}
                    {claim.count >= AGREEMENT_THRESHOLD ? ' · corroborated' : ''}
                  </span>{' '}
                  <span className="claim-voters">{claim.voterLabels.join(', ')}</span>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void decide(g, claim.fingerprint)}
                    >
                      Set the record to this
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {status ? (
        <p role="status" className="status-banner">
          {status}
        </p>
      ) : null}
    </section>
  );
}

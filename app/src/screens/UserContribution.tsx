// screens/UserContribution.tsx
//
// What one person contributed, read-only.
//
// ---------------------------------------------------------------------------
// The link promised one thing and delivered another
// ---------------------------------------------------------------------------
// AdminUserDetail lists what someone has recently contributed, and every row was a link
// into WordReview - the screen where you record your own opinion of a word. Following
// "entry · 3 days ago" from Ada's page opened a form asking the curator what THEY thought
// the entry should be. The one thing the row promised - what Ada said - appeared nowhere on
// the screen it led to.
//
// This is that screen. It shows the claim, the record it is being compared against, and the
// rest of what the same person did to the same word: their other axes, their example, their
// recordings, playable.
//
// ---------------------------------------------------------------------------
// Read-only means read-only
// ---------------------------------------------------------------------------
// There is no exclude button here, and no confirm. The word dossier has both, correctly -
// it is the screen for adjudicating a word, where a curator is looking at everybody's
// claims side by side. This screen is reached with one person's name at the top, and a
// moderation control in that frame invites the question the evidence model exists to avoid:
// "is Ada right?" rather than "what is true?". The dossier is one link away.
//
// Superseded and excluded rows are shown as such rather than hidden. Someone's record
// includes the work that was set aside - a filtered view would hide exactly the thing a
// curator reading it needs.

import { base64ToAudioUrl, type ReleaseState, type UserContributionClaim, type UserContributionDetail, getUserContribution } from '../api.js';
import { useEffect, useState } from 'react';
import { CurrentRecord, OutcomeSummary } from './ClaimViews.js';
import type { ContributionOutcome } from '@yoruba-student-dict-platform/shared';

export interface UserContributionProps {
  userId: string;
  contributionId: string;
  /** The person's own page - where this was reached from, and where their other work is. */
  onOpenUser: (userId: string) => void;
  /** Everything anyone holds about this word, which is also where it gets moderated. */
  onOpenDossier: (wordId: string) => void;
  /** The review screens. Offered, and labelled for what it is - the complaint that produced
   * this screen was an UNLABELLED link into it, not the existence of the destination. */
  onOpenWord: (wordId: string) => void;
}

function when(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

/** The axes a resolved outcome exists for. A 'new_entry' proposal and any row submitted
 * before 0013 have no resolved value, and their proposed_value is a different shape
 * entirely - so the claim falls back to its raw JSON rather than being rendered as a claim
 * it never was. */
function asOutcome(value: unknown): ContributionOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'entry' || kind === 'etymology' ? (value as ContributionOutcome) : null;
}

/** Whether the record agrees, said in words rather than as a bare boolean.
 *
 * Fingerprints are compared, not values - the same rule consensus uses to decide two people
 * asserted the same thing. 'Cannot tell' is its own answer: an axis nobody has decided is
 * not a disagreement, and showing it as one would put a dispute on screen that nobody is
 * having. */
function AgreementNote({ claim }: { claim: UserContributionClaim }) {
  if (claim.agreesWithRecord === null) {
    return (
      <span className="field-note">
        {claim.valueFingerprint ? 'nothing decided on this axis yet' : 'submitted before outcomes were recorded'}
      </span>
    );
  }
  return claim.agreesWithRecord ? (
    <span className="state golden">this is what the record says</span>
  ) : (
    <span className="state provisional">the record says something else</span>
  );
}

function ClaimBlock({ claim }: { claim: UserContributionClaim }) {
  const outcome = asOutcome(claim.resolvedValue);
  const setAside = claim.status !== 'active';

  return (
    <div className={`dossier-section${setAside ? ' set-aside' : ''}`} aria-label={`Claim: ${claim.axis}`}>
      <h3>{claim.axis === 'new_entry' ? 'A new word' : claim.axis}</h3>
      <p className="field-note">
        <span className="state none">{claim.status}</span> · {when(claim.submittedAt)} · <AgreementNote claim={claim} />
      </p>
      {/* What they actually claimed. Rendered as the assertion rather than as the action
          that produced it, the same way the decision queues render it - two routes to the
          same claim should not look like two different claims. */}
      {outcome ? (
        <p>
          <OutcomeSummary outcome={outcome} />
        </p>
      ) : (
        <pre>{JSON.stringify(claim.resolvedValue ?? claim.proposedValue, null, 2)}</pre>
      )}
      {claim.note ? (
        <p>
          <em>“{claim.note}”</em>
        </p>
      ) : null}
      {claim.status === 'superseded' ? (
        <p className="field-note">
          Superseded by something they submitted later. Kept deliberately — a change of mind is evidence too.
        </p>
      ) : null}
      {claim.excludedReason ? (
        <p className="field-note">
          Removed from the tally {when(claim.excludedAt)}: {claim.excludedReason}
        </p>
      ) : null}
    </div>
  );
}

/** Rights, stated where the content is rather than one screen away.
 *
 * An example or a recording under an unknown or withdrawn grant must not be mistakable for
 * something publishable, and 'unknown' is the commonest state: it means nobody has asked
 * yet, which 0019 keeps distinct from a refusal on purpose. */
function RightsNote({ state, what }: { state: ReleaseState; what: string }) {
  if (state === 'agreed') return null;
  return (
    <p className="field-note">
      <span className="state blocked">rights: {state}</span>{' '}
      {state === 'unknown' ? `nobody has asked about ${what} yet` : `${what} may not be published`}
    </p>
  );
}

export function UserContribution({ userId, contributionId, onOpenUser, onOpenDossier, onOpenWord }: UserContributionProps) {
  const [detail, setDetail] = useState<UserContributionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getUserContribution(userId, contributionId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, contributionId]);

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load this contribution: {error}
      </p>
    );
  if (!detail) return <p>Loading contribution...</p>;

  const who = detail.displayName ?? detail.email;
  const word = detail.word;
  const axis = detail.contribution.axis;

  return (
    <section aria-label="Contribution detail">
      {/* The word first, then whose work this is. Both, always: the list this was reached
          from showed the word, and a detail view that drops what the row said is the defect
          this screen exists to fix. */}
      <h2>{word ? word.displayText : 'A proposed new word'}</h2>
      <p className="field-note">
        contributed by{' '}
        <button type="button" className="btn btn-link" onClick={() => onOpenUser(detail.userId)}>
          {who}
        </button>
        {word ? <span className="word-id"> · {word.wordId}</span> : null}
      </p>
      <p className="field-note">Read-only. Nothing on this screen changes the record.</p>

      {word ? (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => onOpenDossier(word.wordId)}>
            Everything on this word
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => onOpenWord(word.wordId)}>
            Review this word
          </button>
        </div>
      ) : null}

      <div className="dossier-grid">
        <ClaimBlock claim={detail.contribution} />

        {/* What it is being compared against. A claim with no baseline asks the reader to
            judge a spelling without saying which one the dictionary already holds. */}
        {word && (axis === 'entry' || axis === 'etymology') ? (
          <div className="dossier-section" aria-label="The record now">
            <h3>The record now</h3>
            <CurrentRecord
              axis={axis}
              displayText={word.displayText}
              syllables={word.syllables}
              definition={word.definition}
              citedEntryId={word.citedEntryId}
              components={word.components.map((c) => c.wordId)}
            />
          </div>
        ) : null}

        {detail.alsoOnThisWord.length > 0 ? (
          <div className="dossier-section" aria-label="Their other claims">
            <h3>Also from {who} on this word</h3>
            {detail.alsoOnThisWord.map((c) => (
              <ClaimBlock key={c.contributionId} claim={c} />
            ))}
          </div>
        ) : null}

        <div className="dossier-section" aria-label="Their recordings">
          <h3>Recordings</h3>
          {detail.recordings.length === 0 ? (
            <p className="field-note">They have not recorded this word.</p>
          ) : (
            <ul className="plain-list">
              {detail.recordings.map((r) => (
                <li key={r.utteranceId}>
                  <strong>take {r.takeNumber}</strong> · {r.speakerName} · {when(r.recordedAt)}
                  <div className="field-note">
                    said as “{r.recordedDisplayText}” ({r.recordedSyllables.join(' · ')}) · {r.segmentCount} clip
                    {r.segmentCount === 1 ? '' : 's'}
                    {r.durationS !== null ? ` · ${r.durationS.toFixed(2)}s` : ''} · {r.status}
                  </div>
                  {/* The publish step drops a take recorded under a spelling the word no
                      longer has, silently. Said out loud here, beside the audio. */}
                  {!r.matchesGolden ? (
                    <p className="field-note">
                      <span className="state provisional">no longer matches</span> the word's current spelling or
                      syllables, so the publish step would skip it.
                    </p>
                  ) : null}
                  <RightsNote state={r.releaseState} what="this voice" />
                  {r.audioDataBase64 ? (
                    <audio controls src={base64ToAudioUrl(r.audioDataBase64, r.deliveryMediaType ?? 'audio/wav')} />
                  ) : (
                    <p className="field-note">No playable copy of this take is stored.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="dossier-section" aria-label="Their example">
          <h3>Example of it in use</h3>
          {detail.examples.length === 0 ? (
            <p className="field-note">They have not written an example for this word.</p>
          ) : (
            <ul className="plain-list">
              {detail.examples.map((e) => (
                <li key={e.exampleId} className={e.excludedReason ? 'set-aside' : undefined}>
                  <strong>{e.exampleText}</strong> — {e.translation}
                  <div className="field-note">
                    {e.exampleType} · {when(e.submittedAt)}
                  </div>
                  {e.wordTextChanged ? (
                    <p className="field-note">
                      <span className="state provisional">recorded as {e.recordedWordText}</span> — the word has been
                      respelled since.
                    </p>
                  ) : null}
                  {e.excludedReason ? (
                    <p className="field-note">
                      Removed from the collection {when(e.excludedAt)}: {e.excludedReason}
                    </p>
                  ) : null}
                  <RightsNote state={detail.releaseState} what="their written work" />
                  <audio controls src={base64ToAudioUrl(e.audioDataBase64)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

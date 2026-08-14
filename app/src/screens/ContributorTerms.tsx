// screens/ContributorTerms.tsx
//
// The one-time question, asked after login and not again until the wording changes.
//
// ---------------------------------------------------------------------------
// It interrupts, and it does not trap
// ---------------------------------------------------------------------------
// Interrupts, because a consent question tucked into a settings page is one nobody
// finds, and the answer is needed before anything can be published rather than after.
// Does not trap, because both answers let someone straight through: declining records
// a real answer (0019's 'declined') and changes nothing about their work here. Consent
// obtained by withholding a paid contributor's job is not consent, and the material
// stays usable internally either way - that is what the engagement was for.
//
// So there is no "later" button. Not because the answer is compulsory, but because
// "later" is the one response that would keep reappearing forever - and a prompt that
// reappears is how a no becomes a yes by attrition.
//
// ---------------------------------------------------------------------------
// The open-release half is asked separately, because the terms promise it is
// ---------------------------------------------------------------------------
// CONTRIBUTOR_TERMS says "You can say no to this part and yes to the rest", so it is a
// real choice on this screen rather than a line in a paragraph with one Accept button
// under it. The server refuses an acceptance that leaves it unanswered.

import { useState } from 'react';
import { CONTRIBUTOR_TERMS, CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { recordMyGrant, type GrantStatus } from '../api.js';

export interface ContributorTermsProps {
  /** The name we would credit them under if they choose their own name - their account
   * display name, so the choice is concrete rather than hypothetical. */
  displayName: string;
  /** Set when this account has already declined or withdrawn, so the screen is being shown
   * again rather than for the first time. Only changes what is SAID: the state it explains
   * is one the server is enforcing either way, and a screen that stayed silent about it
   * would leave someone re-reading terms they thought they had already answered. */
  paused?: boolean;
  onAnswered: (status: GrantStatus) => void;
}

export function ContributorTerms({ displayName, paused = false, onAnswered }: ContributorTermsProps) {
  const [openRelease, setOpenRelease] = useState(true);
  const [attributionMode, setAttributionMode] = useState<'real_name' | 'pseudonym' | 'anonymous'>('real_name');
  const [attributionName, setAttributionName] = useState(displayName);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(input: Parameters<typeof recordMyGrant>[0]) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      onAnswered(await recordMyGrant(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Contributor agreement" className="card">
      {paused ? (
        <>
          <h2>Contributions are paused</h2>
          <div role="alert" aria-label="Contributions paused" className="warning-banner">
            <p>
              This account declined the contributor agreement, so recording and submitting work are turned off. Nothing
              you contributed before is affected, and it is all still here.
            </p>
            <p className="field-note">
              You can agree below to start again. If you would rather not, you can close this page or{' '}
              <a href="/logout">log out</a> - nobody will ask you again in this session.
            </p>
          </div>
        </>
      ) : (
        <>
          <h2>Before you start</h2>
          <p className="field-note">
            One question, once. It is about what may be done with the recordings you make and the examples you write.
          </p>
        </>
      )}

      <ul className="plain-list">
        {CONTRIBUTOR_TERMS.map((point) => (
          <li key={point.records}>
            <p>{point.text}</p>
          </li>
        ))}
      </ul>

      {declining ? (
        <div className="field">
          <label htmlFor="decline-reason-field">Anything you want to add? (optional)</label>
          <input
            id="decline-reason-field"
            type="text"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Not required - declining is a complete answer on its own"
          />
          <div className="field-inline">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => send({ termsVersion: CONTRIBUTOR_TERMS_VERSION, declineReason })}
            >
              Confirm - do not publish my work outside Speak Nigeria
            </button>{' '}
            <button type="button" className="btn btn-secondary" onClick={() => setDeclining(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <p>
              <label>
                <input type="checkbox" checked={openRelease} onChange={(e) => setOpenRelease(e.target.checked)} />{' '}
                Speak Nigeria may also publish some of my work openly, for anyone to use.
              </label>
            </p>
            <p className="field-note">
              Unchecking this keeps everything else the same. Your work is still used in Speak Nigeria&apos;s own
              materials; it is simply never published outside them.
            </p>
          </div>

          <div className="field">
            <p>If my work is published, credit me as:</p>
            {(
              [
                ['real_name', `My own name (${displayName})`],
                ['pseudonym', 'Another name'],
                ['anonymous', 'Do not credit me'],
              ] as const
            ).map(([mode, label]) => (
              <div key={mode} className="field-inline">
                <label>
                  <input
                    type="radio"
                    name="attribution-mode"
                    checked={attributionMode === mode}
                    onChange={() => setAttributionMode(mode)}
                  />
                  {label}
                </label>
              </div>
            ))}
            {attributionMode === 'pseudonym' ? (
              <input
                aria-label="Name to credit"
                type="text"
                value={attributionName}
                onChange={(e) => setAttributionName(e.target.value)}
              />
            ) : null}
            <p className="field-note">You can change this later; it is a preference, not part of the agreement.</p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() =>
              send({
                termsVersion: CONTRIBUTOR_TERMS_VERSION,
                openReleasePermitted: openRelease,
                attributionMode,
                attributionName: attributionMode === 'pseudonym' ? attributionName : null,
              })
            }
          >
            I agree
          </button>{' '}
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setDeclining(true)}>
            I do not agree
          </button>
        </>
      )}

      {error ? (
        <p role="alert" className="warning-banner">
          {error}
        </p>
      ) : null}
    </section>
  );
}

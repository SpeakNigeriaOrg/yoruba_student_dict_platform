// screens/ContributorTerms.tsx
//
// The one-time question, asked after login and not again until the wording changes.
//
// ---------------------------------------------------------------------------
// It interrupts, because the answer decides whether anything can be saved
// ---------------------------------------------------------------------------
// A consent question tucked into a settings page is one nobody finds, and every write
// endpoint refuses an account that declined - so putting the queue in front of someone
// who has not answered would be showing them work they cannot keep. There is no "later"
// button for the same reason.
//
// ---------------------------------------------------------------------------
// One agreement, one button
// ---------------------------------------------------------------------------
// This screen used to carry a checkbox for open publication and a radio group for how
// someone wanted to be credited. Both are gone: the terms now assign everything created
// in the portal to Speak Nigeria, so there is no per-person permission left to collect,
// and crediting on Wikimedia Commons is carried by the uploaded file's own metadata
// rather than by anything recorded here. What is left is the thing actually being asked.

import { useState } from 'react';
import { CONTRIBUTOR_TERMS, CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { recordMyGrant, type GrantStatus } from '../api.js';

export interface ContributorTermsProps {
  /** Set when this account has already declined or withdrawn, so the screen is being shown
   * again rather than for the first time. Only changes what is SAID: the state it explains
   * is one the server is enforcing either way, and a screen that stayed silent about it
   * would leave someone re-reading terms they thought they had already answered. */
  paused?: boolean;
  onAnswered: (status: GrantStatus) => void;
}

export function ContributorTerms({ paused = false, onAnswered }: ContributorTermsProps) {
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
            <p>This account declined the contributor agreement, so recording and submitting work are turned off.</p>
            <p className="field-note">
              You can agree below to start again, or <a href="/logout">log out</a>.
            </p>
          </div>
        </>
      ) : (
        <>
          <h2>Before you start</h2>
          <p className="field-note">One question, once.</p>
        </>
      )}

      <ul className="plain-list" aria-label="Contributor agreement terms">
        {CONTRIBUTOR_TERMS.map((point) => (
          <li key={point.slice(0, 40)}>
            <p>{point}</p>
          </li>
        ))}
      </ul>

      <p className="field-note">
        If you do not agree, you can still sign in and read the dictionary, but you will not be able to record or
        submit work.
      </p>

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
              Confirm
            </button>{' '}
            <button type="button" className="btn btn-secondary" onClick={() => setDeclining(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => send({ termsVersion: CONTRIBUTOR_TERMS_VERSION })}
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

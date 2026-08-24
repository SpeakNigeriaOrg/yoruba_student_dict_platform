// screens/RightsRoster.tsx
//
// Who has agreed to the contributor terms, who has refused, and who nobody has asked.
//
// 0019 built two views to answer exactly this and said so - "'Who have we not asked' is a
// question about people, not about assets" - and they have only ever been queried one
// person at a time, by the person themselves. So the roster has never existed.
//
// The row that matters most is the one the in-app prompt structurally cannot fix: a voice
// with no account. Three of those carry 189 recordings. They need an out-of-band grant
// naming the real instrument, because writing an in-app acceptance on their behalf would
// launder an assumption into a consent someone gave on a date.

import { useEffect, useState } from 'react';
import { getRightsRoster, type ReleaseState, type RightsRoster as Roster } from '../api.js';

/** Green for agreed, red for a refusal (a dead end for publication), amber for unknown -
 * outstanding work rather than an answer. Deliberately NOT grey: nobody having asked is a
 * task, not a blank. */
const STATE_WEIGHT: Record<ReleaseState, string> = {
  agreed: 'golden',
  declined: 'blocked',
  revoked: 'blocked',
  unknown: 'provisional',
};

function StateMark({ state }: { state: ReleaseState }) {
  return <span className={`state ${STATE_WEIGHT[state]}`}>{state}</span>;
}

export function RightsRoster() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRightsRoster()
      .then((r) => {
        if (!cancelled) setRoster(r);
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
        Couldn't load the rights roster: {error}
      </p>
    );
  if (!roster) return <p>Loading the rights roster...</p>;

  return (
    <section aria-label="Rights roster">
      <p className="field-note">
        The wording currently in force is <strong>{roster.currentTermsVersion}</strong>. An agreement recorded against
        an earlier version is not consent to this one.
      </p>

      {roster.counts.speakersWithoutAccount > 0 ? (
        <div className="warning-banner" aria-label="Unreachable speakers">
          {roster.counts.speakersWithoutAccount} voice
          {roster.counts.speakersWithoutAccount === 1 ? '' : 's'} in the recordings have no account, so the in-app
          prompt can never reach them. Their {roster.counts.utterancesWithoutAgreement} recording
          {roster.counts.utterancesWithoutAgreement === 1 ? '' : 's'} need an out-of-band grant naming the real
          instrument — a contract, a signed form — recorded against the speaker. Writing an acceptance for them would
          turn an assumption into a consent someone is recorded as having given.
        </div>
      ) : null}

      <h3>Speakers</h3>
      <div className="table-scroll">
        <table className="survey">
          <thead>
            <tr>
              <th>Voice</th>
              <th>Rights</th>
              <th>How</th>
              <th>Stated</th>
              <th>Recordings</th>
              <th>Account</th>
            </tr>
          </thead>
          <tbody>
            {roster.speakers.map((s) => (
              <tr key={s.speakerId}>
                <td>
                  {s.displayName}
                  {s.dialectRegion ? <span className="field-note"> · {s.dialectRegion}</span> : null}
                </td>
                <td>
                  <StateMark state={s.releaseState} />
                </td>
                <td>{s.instrument ?? '-'}</td>
                <td>{s.statedOn ?? '-'}</td>
                <td>
                  <span className={`figure${s.utteranceCount === 0 ? ' zero' : ''}`}>{s.utteranceCount}</span>
                </td>
                <td>{s.hasAccount ? 'yes' : <span className="state provisional">no account</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Contributors</h3>
      <div className="table-scroll">
        <table className="survey">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Rights</th>
              <th>How</th>
              <th>Stated</th>
              <th>Examples</th>
              <th>Votes</th>
            </tr>
          </thead>
          <tbody>
            {roster.contributors.map((c) => (
              <tr key={c.userId}>
                <td>
                  {c.displayName ?? c.email}
                  <br />
                  <span className="word-id">{c.email}</span>
                </td>
                <td>{c.role}</td>
                <td>
                  <StateMark state={c.releaseState} />
                </td>
                <td>{c.instrument ?? '-'}</td>
                <td>{c.statedOn ?? '-'}</td>
                <td>
                  <span className={`figure${c.exampleCount === 0 ? ' zero' : ''}`}>{c.exampleCount}</span>
                </td>
                <td>
                  <span className={`figure${c.contributionCount === 0 ? ' zero' : ''}`}>{c.contributionCount}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="field-note">
        Internal use is not gated on any of this — the teachers were paid to record for exactly that purpose. What a
        refusal or an unanswered question withholds is external release: the Wiktionary export emits audio only for a
        speaker who has agreed, and an example only where its author has.
      </p>
    </section>
  );
}

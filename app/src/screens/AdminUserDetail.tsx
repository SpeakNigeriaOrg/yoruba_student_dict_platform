// screens/AdminUserDetail.tsx
//
// Everything held about one person, and the controls for changing it.
//
// ---------------------------------------------------------------------------
// The page about a user never said who the user was
// ---------------------------------------------------------------------------
// This screen was a word-assignment manager and nothing else. It did not show the email,
// the display name, the role, or when the account was created - it never named the person
// whose page it was. A curator clicking a name in the Users list arrived somewhere that had
// forgotten the name.
//
// Worse than an empty section, because the list they came from showed MORE: the name, the
// role, three assignment counts and the promote/demote control. Following the link lost
// information, which is the one thing a detail view must never do.
//
// The email matters most. It is what Google authenticates and what GetRoles matches on to
// decide whether someone is a curator at all; display_name is nullable and duplicable. "Is
// this the right account?" is the question this screen is opened to answer, and without the
// address it cannot be answered here.
//
// The route is deep-linkable (#/users/{id}) and mounts with only a userId, so it cannot
// borrow the list's copy of the user. It asks - GET /api/users/{userId}.

import { useEffect, useState } from 'react';
import {
  assignWords,
  assignWordsByScope,
  getUserAssignments,
  getUserDossier,
  unassignWord,
  updateUser,
  type AssignmentScope,
  type UserAssignmentSummary,
  type UserDossier,
} from '../api.js';
import { AxisStatusBadges } from './AxisStatusBadges.js';
import { AxisReviewBadges } from './AxisReviewBadges.js';
import { WordAssignPicker } from './WordAssignPicker.js';

export interface AdminUserDetailProps {
  userId: string;
  /** Opening a word to WORK on it - what the assigned-words list is for. */
  onSelectWord: (wordId: string) => void;
  /** Reading what this person contributed, which is what the activity list is for.
   *
   * The two were the same link until now, and it went to the review screens: clicking
   * "entry · 3 days ago" on Ada's page opened a form asking the curator for their own
   * opinion, with no trace of Ada's. See screens/UserContribution.tsx. */
  onOpenContribution: (contributionId: string) => void;
  /** Both optional since this is now its own route (#/users/{id}) rather
   * than a child of AdminUsers: the shell renders the back affordance from
   * real history, and the user list re-fetches its counts when it re-mounts,
   * so neither needs threading through. Kept as hooks for callers that do
   * want to react in place. */
  onBack?: () => void;
  onUsersChanged?: () => void;
}

function when(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** Whether this person's work may be published, and on what basis.
 *
 * The version is shown beside the state, not instead of it. An agreement to superseded
 * wording still reads as 'agreed' in the view - correctly, they did agree to something -
 * but it does not cover the terms in force, and those two cases need telling apart because
 * only one of them means "ask again". */
function RightsSection({ rights }: { rights: UserDossier['rights'] | undefined }) {
  // Same defensive shape guard the drift section uses: a payload from a deploy where the
  // API is older than the app must render, not throw. This block is supplementary to the
  // assignment manager below, and a crash here would blank the whole page - including the
  // part that was working before this screen gained a dossier at all.
  if (!rights) return null;

  const weight =
    rights.releaseState === 'agreed' ? (rights.coversCurrentTerms ? 'golden' : 'provisional') : rights.releaseState === 'unknown' ? 'provisional' : 'blocked';

  return (
    <div className="dossier-section" aria-label="Rights">
      <h3>Rights</h3>
      <dl>
        <dt>Release state</dt>
        <dd>
          <span className={`state ${weight}`}>{rights.releaseState}</span>
        </dd>
        {rights.releaseState === 'unknown' ? (
          <dd className="field-note">
            Nobody has asked yet — which 0019 keeps distinct from a refusal on purpose. Their work cannot be published
            until they agree.
          </dd>
        ) : null}
        <dt>Agreed to</dt>
        <dd>
          {rights.agreedVersion ?? '(nothing recorded)'}
          {rights.agreedVersion && !rights.coversCurrentTerms ? (
            <div className="field-note">
              The wording in force is now <strong>{rights.currentTermsVersion}</strong>. Consent to the older wording is
              not consent to this one, so they need asking again.
            </div>
          ) : null}
        </dd>
        <dt>Instrument</dt>
        <dd>{rights.instrument ?? '-'}</dd>
        <dt>Stated on</dt>
        <dd>{when(rights.statedOn)}</dd>
        {rights.noGrantReason ? (
          <>
            <dt>No grant because</dt>
            <dd>{rights.noGrantReason}</dd>
          </>
        ) : null}
        {rights.revokedAt ? (
          <>
            <dt>Withdrawn</dt>
            <dd>
              {when(rights.revokedAt)}
              {rights.revokedReason ? ` — ${rights.revokedReason}` : ''}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** Editing the account itself.
 *
 * An invite is typed by hand before the invitee has ever logged in, so a typo in the email
 * is easy to make and silently fatal - the person authenticates with Google and is granted
 * no roles at all, so they reach nothing and cannot be told apart from someone who has not
 * tried. Until this form there was no repair short of direct SQL.
 *
 * Changing the address moves none of their work: user_id is what contributions,
 * assignments, decisions and grants all reference. It re-points which Google identity may
 * sign in as this account, and that is all - which is exactly what makes it both safe and
 * worth warning about. */
function EditProfile({ user, onSaved }: { user: UserDossier; onSaved: () => void }) {
  const [email, setEmail] = useState(user.email);
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Re-seeded when the loaded user changes, so the form never shows one account's values
  // over another's after a navigation.
  useEffect(() => {
    setEmail(user.email);
    setDisplayName(user.displayName ?? '');
    setOpen(false);
    setStatus(null);
  }, [user.userId, user.email, user.displayName]);

  const emailChanged = email.trim().toLowerCase() !== user.email;
  const nameChanged = displayName.trim() !== (user.displayName ?? '');

  async function save() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await updateUser(user.userId, {
        ...(emailChanged ? { email: email.trim() } : {}),
        // Empty clears it, and the server stores that as null so "no display name" has one
        // representation and the email fallback keeps working everywhere else.
        ...(nameChanged ? { displayName: displayName.trim() || null } : {}),
      });
      setStatus('Saved.');
      onSaved();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className="field-note">
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
          Edit this account
        </button>
      </p>
    );
  }

  return (
    <div className="dossier-section" aria-label="Edit account">
      <h3>Edit account</h3>
      <div className="field">
        <label htmlFor="user-email-field">Email address</label>
        <input
          id="user-email-field"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="field-note">
          The Google address they sign in with. Correcting it re-points who may sign in as this account and moves none
          of their work. A curator cannot change their own — the lockout would only show up at their next sign-in.
        </p>
      </div>
      <div className="field">
        <label htmlFor="user-name-field">Display name</label>
        <input
          id="user-name-field"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="(none - the email is shown instead)"
        />
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || (!emailChanged && !nameChanged)}
          onClick={() => void save()}
        >
          {busy ? 'Saving...' : 'Save changes'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </div>
  );
}

export function AdminUserDetail({ userId, onSelectWord, onOpenContribution, onBack, onUsersChanged }: AdminUserDetailProps) {
  const [user, setUser] = useState<UserDossier | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<UserAssignmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function reloadUser() {
    getUserDossier(userId)
      .then(setUser)
      .catch((err: unknown) => setUserError(err instanceof Error ? err.message : String(err)));
  }

  function reload() {
    getUserAssignments(userId)
      .then(setAssignments)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    setUser(null);
    setUserError(null);
    reloadUser();
    reload();
  }, [userId]);

  async function runAssign(assign: () => Promise<{ created: string[]; alreadyAssigned: string[] }>) {
    try {
      const result = await assign();
      setStatus(
        `Assigned ${result.created.length} word(s).` +
          (result.alreadyAssigned.length > 0 ? ` (${result.alreadyAssigned.length} were already assigned.)` : ''),
      );
      reload();
      onUsersChanged?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAssign(wordIds: string[]) {
    return runAssign(() => assignWords(userId, wordIds));
  }

  function handleAssignScope(scope: AssignmentScope) {
    return runAssign(() => assignWordsByScope(userId, scope));
  }

  async function handleUnassign(wordId: string) {
    try {
      await unassignWord(userId, wordId);
      setStatus(`Unassigned ${wordId}.`);
      reload();
      onUsersChanged?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section aria-label="User assignment detail">
      {/* Only rendered when a caller supplies its own back handling. As a
          route (#/users/{id}) the shell renders one from real history, and a
          second button here would just duplicate it. */}
      {onBack ? (
        <button type="button" className="back-btn" onClick={onBack}>
          ← Back
        </button>
      ) : null}

      {userError ? <p role="alert" className="error-banner">Couldn't load this user: {userError}</p> : null}

      {/* `user.email` rather than `user`, and that is the guard rather than a null check on
          the object. The email IS the identity here - it is what this screen exists to show -
          so a payload without one is not a user this page can describe, and rendering a
          profile around it would put an empty heading and an unfillable edit form on screen.
          The assignment manager below still renders either way: it was here first, and a
          dossier that cannot load must not take it down with it. */}
      {user?.email ? (
        <div aria-label="User identity">
          {/* The display name is the heading only when there IS one. A blank h2 over an
              account with no name told the reader nothing; the email always tells them
              something, and it is the identity anyway. */}
          <h2>{user.displayName ?? user.email}</h2>
          {/* Always shown, even when it is already the heading. This is the field a curator
              came here to read, and making it conditional on having no display name would
              hide it from exactly the accounts that are easiest to confuse. */}
          <p className="user-email">{user.email}</p>
          <p>
            <span className={`badge${user.role === 'curator' ? ' decided' : ''}`}>{user.role}</span>{' '}
            <span className="field-note">account created {when(user.createdAt)}</span>
          </p>

          <EditProfile
            user={user}
            onSaved={() => {
              reloadUser();
              onUsersChanged?.();
            }}
          />

          <div className="dossier-grid">
            <RightsSection rights={user.rights} />

            <div className="dossier-section" aria-label="Activity">
              <h3>What they have done</h3>
              {!user.contributions || user.contributions.length === 0 ? (
                <p className="field-note">No contributions yet.</p>
              ) : (
                <dl>
                  {user.contributions.map((c) => (
                    <div key={c.axis}>
                      <dt>{c.axis}</dt>
                      <dd>
                        <span className="figure">{c.active}</span> active
                        {/* Superseded and excluded are shown rather than folded into a
                            total: one is a revised belief (0013 keeps it deliberately),
                            the other is a vote a curator removed from the tally, and
                            whether someone's work is being thrown out is the thing a
                            single number would hide. */}
                        {c.superseded > 0 ? ` · ${c.superseded} superseded` : ''}
                        {c.excluded > 0 ? ` · ${c.excluded} excluded` : ''}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <dl>
                <dt>Examples written</dt>
                <dd>{user.exampleCount}</dd>
                <dt>Recordings</dt>
                <dd>{user.utteranceCount}</dd>
                <dt>Images uploaded</dt>
                <dd>{user.imageCount}</dd>
                <dt>Words they last changed</dt>
                <dd>{user.wordsTouched}</dd>
                {/* Only a curator can set the record, so this is 0 for every volunteer and
                    saying so is more useful than hiding the row. */}
                <dt>Records set</dt>
                <dd>{user.decisionsMade}</dd>
              </dl>
            </div>

            {user.speakers?.length ? (
              <div className="dossier-section" aria-label="Voice">
                <h3>Voice</h3>
                <ul className="plain-list">
                  {user.speakers.map((s) => (
                    <li key={s.speakerId}>
                      <strong>{s.displayName}</strong>
                      {s.dialectRegion ? ` · ${s.dialectRegion}` : ''}
                      <div className="field-note">
                        {s.utteranceCount} recording{s.utteranceCount === 1 ? '' : 's'}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {user.recentContributions?.length ? (
              <div className="dossier-section" aria-label="Recent contributions">
                <h3>Recently</h3>
                <ul className="plain-list">
                  {user.recentContributions.map((c) => (
                    <li key={c.contributionId} className={c.status !== 'active' ? 'set-aside' : undefined}>
                      {/* Keyed on the contribution, not the word - which is what makes a
                          'new_entry' proposal clickable at all. It has no word by
                          construction, so this row used to be dead text: the work of
                          someone whose main activity is proposing new words was the one
                          thing their own page would not open. */}
                      <button type="button" className="btn btn-link" onClick={() => onOpenContribution(c.contributionId)}>
                        {c.displayText ?? c.wordId ?? 'a new word'}
                      </button>{' '}
                      <span className="badge">{c.axis}</span>{' '}
                      <span className="field-note">
                        {c.status} · {when(c.submittedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : userError ? null : (
        <p>Loading user...</p>
      )}

      <h3>Assigned words</h3>
      <WordAssignPicker userId={userId} onAssign={handleAssign} onAssignScope={handleAssignScope} />

      {error ? <p role="alert" className="error-banner">Couldn't load assignments: {error}</p> : null}
      {!assignments ? (
        <p>Loading assignments...</p>
      ) : assignments.length === 0 ? (
        <p>No words assigned to this user.</p>
      ) : (
        <ul aria-label="Assigned words" className="card-list">
          {assignments.map((a) => (
            <li key={a.wordId} className="card-row">
              <button type="button" className="row-title" onClick={() => onSelectWord(a.wordId)}>
                {a.displayText}
              </button>
              {a.definition ? <span> — {a.definition}</span> : null}
              <br />
              <AxisStatusBadges axisDecided={a.axisDecided} />
              <br />
              <AxisReviewBadges reviewStatus={a.reviewStatus} />
              <div className="btn-row">
                <button type="button" className="btn btn-danger" onClick={() => handleUnassign(a.wordId)}>
                  Unassign
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </section>
  );
}

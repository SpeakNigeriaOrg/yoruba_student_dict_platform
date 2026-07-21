// screens/AddUserForm.tsx
//
// Curator-only form to pre-register a user account by username, ahead of
// their first login - identity providers are GitHub today (Microsoft
// planned), so "username" here means that account's login identifier, not
// a made-up name. See api.ts's createUser header comment for why a
// 'curator' role picked here isn't durable on its own - it's shown as an
// inline note below the role picker rather than left as a silent gotcha.

import { useState } from 'react';
import { createUser } from '../api.js';

export interface AddUserFormProps {
  onCreated: () => void;
}

export function AddUserForm({ onCreated }: AddUserFormProps) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'volunteer' | 'curator'>('volunteer');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setSubmitting(true);
    setError(null);
    setStatus(null);
    try {
      const user = await createUser({
        username: username.trim(),
        displayName: displayName.trim() ? displayName.trim() : undefined,
        role,
      });
      setStatus(`Added ${user.username} as ${user.role}.`);
      setUsername('');
      setDisplayName('');
      setRole('volunteer');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add a user">
      <div className="field">
        <label htmlFor="add-user-username">GitHub (or Microsoft) username</label>
        <input
          id="add-user-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="their account's login username"
        />
      </div>
      <div className="field">
        <label htmlFor="add-user-display-name">Display name (optional)</label>
        <input
          id="add-user-display-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="defaults to the username"
        />
      </div>
      <div className="field">
        <label htmlFor="add-user-role">Role</label>
        <select id="add-user-role" value={role} onChange={(e) => setRole(e.target.value as 'volunteer' | 'curator')}>
          <option value="volunteer">Volunteer</option>
          <option value="curator">Curator</option>
        </select>
      </div>
      {role === 'curator' ? (
        <p className="field-note">
          Curator access here only takes effect once this username is also invited to the "curator" role via the
          Azure Static Web Apps portal (Role management) - this app can't grant that role by itself yet. Until then,
          this account will sign in as a volunteer.
        </p>
      ) : null}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={submitting || !username.trim()}>
          {submitting ? 'Adding...' : 'Add user'}
        </button>
      </div>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
      {error ? <p role="alert" className="error-banner">{error}</p> : null}
    </form>
  );
}

// screens/AddUserForm.tsx
//
// Curator-only form to register a user account by Google email, ahead of
// their first login.
//
// This is the access gate, not a convenience: any Google account can complete
// a login, so the platform admits people by email address registered here and
// nothing else (see api/src/handlers/getRoles.ts). An unregistered address can
// sign in to Google and still reach nothing.
//
// The former warning under the role picker is gone. It said a 'curator' role
// chosen here only took effect once the same identity was ALSO invited via the
// Azure Static Web Apps portal, because the server re-synced roles from the
// SWA principal on every request. The SWA is on Standard now and the
// roles-source function reads the database, so the role picked here is real.

import { useState } from 'react';
import { createUser } from '../api.js';

export interface AddUserFormProps {
  onCreated: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AddUserForm({ onCreated }: AddUserFormProps) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'volunteer' | 'curator'>('volunteer');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = email.trim();
  // Checked client-side purely to catch a typo before it becomes a row that
  // silently never matches a login. Google is what actually proves ownership.
  const emailLooksValid = EMAIL_PATTERN.test(trimmed);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailLooksValid) return;
    setSubmitting(true);
    setError(null);
    setStatus(null);
    try {
      const user = await createUser({
        email: trimmed,
        displayName: displayName.trim() ? displayName.trim() : undefined,
        role,
      });
      setStatus(`Added ${user.email} as ${user.role}. They can now sign in with Google.`);
      setEmail('');
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
        <label htmlFor="add-user-email">Google email address</label>
        <input
          id="add-user-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
        />
      </div>
      {trimmed && !emailLooksValid ? (
        <p className="field-note">Enter the full Google address they will sign in with.</p>
      ) : null}
      <div className="field">
        <label htmlFor="add-user-display-name">Display name (optional)</label>
        <input
          id="add-user-display-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="defaults to the email address"
        />
      </div>
      <div className="field">
        <label htmlFor="add-user-role">Role</label>
        <select id="add-user-role" value={role} onChange={(e) => setRole(e.target.value as 'volunteer' | 'curator')}>
          <option value="volunteer">Volunteer</option>
          <option value="curator">Curator</option>
        </select>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={submitting || !emailLooksValid}>
          {submitting ? 'Adding...' : 'Add user'}
        </button>
      </div>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
      {error ? <p role="alert" className="error-banner">{error}</p> : null}
    </form>
  );
}

// screens/AdminUsers.tsx
//
// Curator-only "Users" tab: every user account plus a per-user summary of
// assigned/in-review/passed word counts, an add-user form, and a
// drill-down into one user's assigned words (AdminUserDetail). Mirrors
// ContributionQueue.tsx's own list+reload shape, except selecting a row
// here navigates to a detail view rather than triggering an action
// directly - that's local state, same as App.tsx's own
// selectedWordId-vs-list pattern one level up.

import { useEffect, useState } from 'react';
import { getUsers, type UserSummary } from '../api.js';
import { AddUserForm } from './AddUserForm.js';
import { AdminUserDetail } from './AdminUserDetail.js';

export interface AdminUsersProps {
  onSelectWord: (wordId: string) => void;
}

export function AdminUsers({ onSelectWord }: AdminUsersProps) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  function reload() {
    getUsers()
      .then(setUsers)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(reload, []);

  if (selectedUserId) {
    return (
      <AdminUserDetail
        userId={selectedUserId}
        onBack={() => setSelectedUserId(null)}
        onSelectWord={onSelectWord}
        onUsersChanged={reload}
      />
    );
  }

  return (
    <section aria-label="Users">
      <AddUserForm onCreated={reload} />
      {error ? <p role="alert" className="error-banner">Couldn't load users: {error}</p> : null}
      {!users ? (
        <p>Loading users...</p>
      ) : users.length === 0 ? (
        <p>No user accounts yet.</p>
      ) : (
        <ul aria-label="User accounts" className="card-list">
          {users.map((u) => (
            <li key={u.userId} className="card-row">
              <button type="button" className="row-title" onClick={() => setSelectedUserId(u.userId)}>
                {u.displayName ?? u.username}
              </button>
              <span className={`badge${u.role === 'curator' ? ' decided' : ''}`}> {u.role}</span>
              <br />
              {u.assignedWordCount} assigned · {u.inReviewCount} in review · {u.passedCount} passed
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

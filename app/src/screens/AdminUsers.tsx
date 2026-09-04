// screens/AdminUsers.tsx
//
// Curator-only "Users" tab: every user account plus a per-user summary of
// assigned/in-review/passed word counts, and an add-user form. Mirrors
// ReviewQueue.tsx's own list+reload shape.
//
// This used to own a private `selectedUserId` and render AdminUserDetail
// itself. That created a second navigation stack the shell knew nothing
// about, so Users -> a user -> a word -> Back re-mounted this component
// fresh and landed on the user LIST rather than the user you had been
// inside. The detail view is now its own route (#/users/{id}), and selecting
// a row just reports the selection upward.

import { useEffect, useState } from 'react';
import { getUsers, updateUserRole, type UserSummary, type AppRole } from '../api.js';
import { AddUserForm } from './AddUserForm.js';

export interface AdminUsersProps {
  onSelectUser: (userId: string) => void;
}

const ASSIGNABLE_ROLES: AppRole[] = ['curator', 'volunteer', 'observer'];

export function AdminUsers({ onSelectUser }: AdminUsersProps) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleStatus, setRoleStatus] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  function reload() {
    getUsers()
      .then(setUsers)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(reload, []);

  async function changeRole(userId: string, role: AppRole) {
    setRoleError(null);
    setRoleStatus(null);
    try {
      const updated = await updateUserRole(userId, role);
      setRoleStatus(`${updated.displayName ?? updated.email} is now a ${updated.role}. Takes effect on their next sign-in.`);
      reload();
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : String(err));
    }
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
              <button type="button" className="row-title" onClick={() => onSelectUser(u.userId)}>
                {u.displayName ?? u.email}
              </button>
              <span className={`badge${u.role === 'curator' ? ' decided' : ''}`}> {u.role}</span>
              <br />
              {u.assignedWordCount} assigned · {u.inReviewCount} in review · {u.passedCount} passed
              {/* Role management lives here rather than in the Azure Portal
                  now that the roles-source function reads users.role. */}
              <div className="btn-row">
                {/* Three roles no longer fit a toggle, so each account offers the two it
                    is not. 'observer' is the board-member role from migration 0027: sees
                    every curator screen, changes nothing. It exists because board members
                    were being made curators purely to get oversight. */}
                {ASSIGNABLE_ROLES.filter((role) => role !== u.role).map((role) => (
                  <button
                    key={role}
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`Make ${u.displayName ?? u.email} a ${role}`}
                    onClick={() => void changeRole(u.userId, role)}
                  >
                    Make {role}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {roleStatus ? <p role="status" className="status-banner">{roleStatus}</p> : null}
      {roleError ? <p role="alert" className="error-banner">{roleError}</p> : null}
    </section>
  );
}

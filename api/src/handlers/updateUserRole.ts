// handlers/updateUserRole.ts
//
// Backs PATCH /api/users/{userId} - curator-only promote/demote.
//
// This endpoint only became possible with the move to the Standard plan.
// Before, users.role was overwritten from principal.userRoles on every
// request, so writing it here would have been pointless - the next request
// would undo it, and the real change had to be made in the Azure Portal's
// manual-invite flow. Now handlers/getRoles.ts reads users.role, so this IS
// the role mechanism.
//
// The change takes effect on the user's next login rather than their next
// request, because SWA caches the roles it got from the roles-source function
// into the session token. Worth knowing when verifying: a demotion is not
// instant. requireCurator still re-reads the database on every request, so a
// demoted curator loses API access as soon as their token is refreshed, and
// cannot act as a curator server-side even while a stale token claims it.

import type { Queryable } from '../db.js';
import { UserNotFoundError } from './errors.js';

export interface UpdateUserRoleInput {
  role: 'curator' | 'volunteer';
}

export interface UpdatedUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
}

export class CannotDemoteLastCuratorError extends Error {
  constructor() {
    super('cannot demote the last curator - promote another curator first');
    this.name = 'CannotDemoteLastCuratorError';
  }
}

export async function updateUserRole(
  db: Queryable,
  userId: string,
  input: UpdateUserRoleInput,
): Promise<UpdatedUser> {
  // Guards against locking the platform out of its own administration:
  // curator is the only role that can grant curator, so demoting the last one
  // would leave no way back in except direct SQL. Checked before the update
  // rather than after, and scoped to the row actually changing.
  if (input.role === 'volunteer') {
    const current = await db.query<{ role: string }>('select role from users where user_id = $1', [userId]);
    if (current.rows.length === 0) throw new UserNotFoundError(userId);
    if (current.rows[0].role === 'curator') {
      const curators = await db.query<{ count: string }>("select count(*) as count from users where role = 'curator'");
      if (Number(curators.rows[0].count) <= 1) throw new CannotDemoteLastCuratorError();
    }
  }

  const result = await db.query<{
    user_id: string;
    email: string;
    display_name: string | null;
    role: 'curator' | 'volunteer';
  }>('update users set role = $2 where user_id = $1 returning user_id, email, display_name, role', [userId, input.role]);

  const row = result.rows[0];
  if (!row) throw new UserNotFoundError(userId);
  return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role };
}

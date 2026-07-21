// handlers/createUser.ts
//
// Backs POST /api/users - curator-only pre-registration of a user account
// by username (their GitHub - or in future, Microsoft - login identifier),
// before they've ever signed in. Lets a curator hand someone a display
// name and a starting role ahead of their first login, rather than that
// user only ever appearing after resolveUser's on-login upsert creates a
// bare 'volunteer' row for them.
//
// IMPORTANT caveat, surfaced to the caller in the frontend copy too:
// role='curator' here is only durable if this username is ALSO invited to
// the 'curator' role via the Azure Static Web Apps portal. auth.ts's
// resolveUser re-syncs role from principal.userRoles on every authenticated
// request (SWA Free plan has no custom roles-source function), so a
// pre-registered curator role gets silently reset to 'volunteer' on that
// user's first real login unless the portal invite happened too.

import type { Queryable } from '../db.js';
import { UsernameAlreadyExistsError } from './errors.js';

export interface CreateUserInput {
  username: string;
  displayName?: string | null;
  role: 'curator' | 'volunteer';
}

export interface CreatedUser {
  userId: string;
  username: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
}

export async function createUser(db: Queryable, input: CreateUserInput): Promise<CreatedUser> {
  try {
    const result = await db.query<{ user_id: string; username: string; display_name: string | null; role: 'curator' | 'volunteer' }>(
      `insert into users (username, display_name, role)
       values ($1, $2, $3)
       returning user_id, username, display_name, role`,
      [input.username, input.displayName ?? input.username, input.role],
    );
    const row = result.rows[0];
    return { userId: row.user_id, username: row.username, displayName: row.display_name, role: row.role };
  } catch (err) {
    if (isUniqueViolation(err)) throw new UsernameAlreadyExistsError(input.username);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === '23505');
}

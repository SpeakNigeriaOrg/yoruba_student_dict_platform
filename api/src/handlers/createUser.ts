// handlers/createUser.ts
//
// Backs POST /api/users - curator-only pre-registration of a user account by
// Google email address, before they've ever signed in.
//
// This is no longer just a convenience: it is the ACCESS GATE. Any Google
// account can complete a login, so being authenticated proves identity, not
// permission. auth.ts's resolveUser looks a user up rather than creating one,
// and handlers/getRoles.ts withholds every custom role from an unregistered
// email - so this endpoint is how anyone gets in at all.
//
// The old caveat here is gone with that change. It used to warn that
// role='curator' was only durable if the same identity was ALSO invited to the
// curator role through the Azure Static Web Apps portal, because resolveUser
// re-synced role from principal.userRoles on every request (the Free plan had
// no roles-source function). The SWA is on Standard now, the roles-source
// function reads users.role, and so the role set here is authoritative - and
// changeable later via PATCH /api/users/{userId}.

import { isUniqueViolation, type Queryable } from '../db.js';
import type { AppRole } from '../auth.js';
import { EmailAlreadyExistsError } from './errors.js';

export interface CreateUserInput {
  email: string;
  displayName?: string | null;
  role: AppRole;
}

export interface CreatedUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: AppRole;
}

export async function createUser(db: Queryable, input: CreateUserInput): Promise<CreatedUser> {
  // Stored lowercase so the row matches what resolveUser/getRoles look up
  // (both normalise to lower(email)), and so whatever case a curator happens
  // to type an invite in cannot matter.
  const email = input.email.trim().toLowerCase();
  try {
    const result = await db.query<{
      user_id: string;
      email: string;
      display_name: string | null;
      role: AppRole;
    }>(
      `insert into users (email, display_name, role)
       values ($1, $2, $3)
       returning user_id, email, display_name, role`,
      [email, input.displayName ?? email, input.role],
    );
    const row = result.rows[0];
    return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role };
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailAlreadyExistsError(email);
    throw err;
  }
}


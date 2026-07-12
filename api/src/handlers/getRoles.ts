// handlers/getRoles.ts
//
// Backs the custom role-source function staticwebapp.config.json's
// auth.rolesSource points at. SWA already grants the built-in
// 'anonymous'/'authenticated' roles on its own regardless of what this
// returns - only the custom 'curator' role needs to be decided here.
//
// Identifies users by GitHub username (userDetails) - see auth.ts's
// header comment for why this isn't email.

import type { Queryable } from '../db.js';
import type { ClientPrincipal } from '../auth.js';

export interface GetRolesResult {
  roles: string[];
}

/** Upserts a users row for the authenticated principal (defaulting to the
 * 'volunteer' role) if one doesn't exist yet - this is the one place a
 * brand-new authenticated user's row gets created, so by the time they
 * reach any write endpoint (which all reference users.user_id via a
 * foreign key), the row is already there. SWA calls this once per
 * session/token-refresh, ahead of the user taking any action in the app. */
export async function getRoles(db: Queryable, principal: ClientPrincipal | null): Promise<GetRolesResult> {
  if (!principal || !principal.userDetails) return { roles: [] };
  const username = principal.userDetails;

  await db.query('insert into users (username, display_name) values ($1, $2) on conflict (username) do nothing', [
    username,
    username,
  ]);

  const result = await db.query<{ role: string }>('select role from users where username = $1', [username]);
  const role = result.rows[0]?.role;
  return { roles: role === 'curator' ? ['curator'] : [] };
}

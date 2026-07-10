// handlers/getRoles.ts
//
// Backs the custom role-source function staticwebapp.config.json's
// auth.rolesSource points at. SWA already grants the built-in
// 'anonymous'/'authenticated' roles on its own regardless of what this
// returns - only the custom 'curator' role needs to be decided here.

import type { Queryable } from '../db.js';
import { findEmailClaim, type ClientPrincipal } from '../auth.js';

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
  if (!principal) return { roles: [] };
  const email = findEmailClaim(principal);
  if (!email) return { roles: [] };

  await db.query('insert into users (email, display_name) values ($1, $2) on conflict (email) do nothing', [
    email,
    principal.userDetails || null,
  ]);

  const result = await db.query<{ role: string }>('select role from users where email = $1', [email]);
  const role = result.rows[0]?.role;
  return { roles: role === 'curator' ? ['curator'] : [] };
}

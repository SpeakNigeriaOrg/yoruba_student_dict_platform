// handlers/getRoles.ts
//
// Backs the custom role-source function staticwebapp.config.json's
// auth.rolesSource points at. Restored from commit d4d9599, which deleted it
// because rolesSource is Standard-SKU-only and the project was on Free; the
// SWA is now Standard, so this is available again.
//
// It does two jobs, and the second is the important one:
//
//   1. Maps users.role onto the custom 'curator' role. The DATABASE is now
//      authoritative for roles - the reverse of the old arrangement, where
//      auth.ts overwrote users.role from SWA's injected userRoles on every
//      request and role changes had to be made through the Azure Portal's
//      manual-invite flow.
//
//   2. Enforces pre-registration. A successful Google login proves only who
//      someone is, not that they were invited: any Google account can reach
//      the login screen. So an email with no users row gets NO roles at all,
//      not even 'member' - and since every /api/* route requires 'member' or
//      'curator', they can authenticate but reach nothing.
//
// 'member' has to be a custom role for that to work: SWA's built-in
// 'authenticated' role is granted to anyone who completes a login, so it
// cannot express "invited" - which is exactly why the route rules were
// changed off it.
//
// Deliberately does NOT create a users row. That was the old behaviour (see
// this file at d4d9599^, which upserted a volunteer row on first sight) and
// it is incompatible with a pre-registration gate: auto-creating a row would
// admit whoever just logged in.

import type { Queryable } from '../db.js';

export interface GetRolesResult {
  roles: string[];
}

/** The body Azure Static Web Apps POSTs to the roles endpoint after a
 * successful login. Field names per the platform's documented contract; the
 * official sample reads only accessToken, but userDetails/claims are what
 * identify the user here. */
export interface RolesRequestBody {
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  claims?: Array<{ typ?: string; val?: string }>;
  accessToken?: string;
}

const EMAIL_CLAIM_TYPES = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'email',
  'emails',
  'preferred_username',
];

/** The login's email address.
 *
 * staticwebapp.config.json sets the Google provider's nameClaimType to the
 * emailaddress claim, so userDetails should already BE the email. The claims
 * scan is a fallback rather than dead code: nameClaimType shapes the client
 * principal, and this endpoint's body is a separate contract, so relying on
 * userDetails alone would make login silently grant zero roles if the two
 * ever diverge. Prefers an explicit email-shaped claim, falls back to
 * userDetails only when it looks like an email. */
export function resolveEmail(body: RolesRequestBody | null | undefined): string | null {
  if (!body) return null;
  for (const typ of EMAIL_CLAIM_TYPES) {
    const claim = body.claims?.find((c) => c.typ === typ && c.val && c.val.includes('@'));
    if (claim?.val) return claim.val.trim().toLowerCase();
  }
  if (body.userDetails && body.userDetails.includes('@')) return body.userDetails.trim().toLowerCase();
  return null;
}

export async function getRoles(db: Queryable, body: RolesRequestBody | null | undefined): Promise<GetRolesResult> {
  const email = resolveEmail(body);
  if (!email) return { roles: [] };

  // Matched case-insensitively, matching the unique index 0012 adds on
  // lower(email) - so a login as Alice@example.com resolves the row
  // registered as alice@example.com rather than being turned away.
  const result = await db.query<{ role: string }>('select role from users where lower(email) = $1', [email]);
  const role = result.rows[0]?.role;

  // No row = not invited. This is the gate.
  if (!role) return { roles: [] };

  // 'observer' is named here so staticwebapp.config.json can let board members reach
  // the curator screens' GETs; requireCurator is what stops them writing.
  if (role === 'curator') return { roles: ['member', 'curator'] };
  if (role === 'observer') return { roles: ['member', 'observer'] };
  return { roles: ['member'] };
}

// auth.ts
//
// Parses the x-ms-client-principal header Azure Static Web Apps injects
// into every authenticated request, and resolves it against the users
// table. SSO alone only proves WHO logged in, not that they're an invited
// participant - that's what the users table lookup is for.
//
// Identity is resolved by EMAIL. That reverses 0004_users_identify_by_
// username.sql, which switched to GitHub usernames because SWA's GitHub
// provider never emits an email claim and its registration schema has no way
// to request one. The provider is now Google, registered as a custom OpenID
// Connect provider with `scopes: [openid, profile, email]` and a
// nameClaimType of the emailaddress claim - so an email is always present,
// and it is a far better durable identifier than a GitHub handle (which its
// owner can rename out from under us).
//
// resolveUser is a LOOKUP, not an upsert. Two reasons:
//
//   1. Pre-registration is the access gate. Any Google account can complete
//      a login, so "authenticated" cannot mean "allowed". A user row must
//      already exist - created by a curator via POST /api/users - or the
//      request is rejected. handlers/getRoles.ts applies the same rule at the
//      edge by withholding the 'member' role; this is the server-side
//      re-check behind it.
//   2. users.role is now AUTHORITATIVE. It used to be overwritten from
//      principal.userRoles on every single request, which made SWA's
//      portal-managed invite state the real source of truth and the database
//      a cache of it. Now the roles-source function reads the database, so
//      the arrow points the other way: a curator promoting someone in the
//      Users screen is the whole mechanism, no Azure Portal step.

import type { Queryable } from './db.js';

export interface ClientPrincipalClaim {
  typ: string;
  val: string;
}

export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
  claims?: ClientPrincipalClaim[];
}

/** SWA base64-encodes the principal JSON into this header on every
 * request once a user is authenticated. Returns null for an absent or
 * unparseable header (an anonymous request, or a malformed one - either
 * way, there's no identity to act on). */
export function parseClientPrincipal(headerValue: string | null | undefined): ClientPrincipal | null {
  if (!headerValue) return null;
  try {
    const decoded = Buffer.from(headerValue, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || !('userId' in parsed) || !parsed.userId) return null;
    const p = parsed as Record<string, unknown>;
    return {
      identityProvider: typeof p.identityProvider === 'string' ? p.identityProvider : '',
      userId: String(p.userId),
      userDetails: typeof p.userDetails === 'string' ? p.userDetails : '',
      userRoles: Array.isArray(p.userRoles) ? (p.userRoles as string[]) : [],
      claims: Array.isArray(p.claims) ? (p.claims as ClientPrincipalClaim[]) : undefined,
    };
  } catch {
    return null;
  }
}

/** A peer set, not a ladder: a volunteer contributes and cannot review, a
 * curator does both, an observer does neither and only reads. */
export type AppRole = 'curator' | 'volunteer' | 'observer';

export interface AppUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: AppRole;
}

const EMAIL_CLAIM_TYPES = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'email',
  'emails',
  'preferred_username',
];

/** This principal's email address. Prefers an explicit email-shaped claim
 * over userDetails: nameClaimType should make userDetails the email already,
 * but a claim is the more specific signal, and falling back only when
 * userDetails looks like an email avoids resolving a display name as an
 * identity. Mirrors handlers/getRoles.ts's own resolveEmail - both sides read
 * the same identity out of two different SWA payload shapes. */
export function resolvePrincipalEmail(principal: ClientPrincipal): string | null {
  for (const typ of EMAIL_CLAIM_TYPES) {
    const claim = principal.claims?.find((c) => c.typ === typ && c.val && c.val.includes('@'));
    if (claim?.val) return claim.val.trim().toLowerCase();
  }
  if (principal.userDetails && principal.userDetails.includes('@')) return principal.userDetails.trim().toLowerCase();
  return null;
}

/** The users row for this principal, or null when there isn't one - which
 * httpAuth.ts turns into a 401. Null covers both "no email on the principal"
 * and "this email was never registered"; neither is a user we can act for,
 * and both are the same answer to the caller.
 *
 * Matched on lower(email) against the unique index 0012 creates, so casing
 * differences between the invite and the login can't create a second account
 * or lock someone out. */
export async function resolveUser(db: Queryable, principal: ClientPrincipal): Promise<AppUser | null> {
  const email = resolvePrincipalEmail(principal);
  if (!email) return null;

  const result = await db.query<{
    user_id: string;
    email: string;
    display_name: string | null;
    role: AppRole;
  }>('select user_id, email, display_name, role from users where lower(email) = $1', [email]);

  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role };
}

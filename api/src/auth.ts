// auth.ts
//
// Parses the x-ms-client-principal header Azure Static Web Apps injects
// into every authenticated request, and resolves it against the users
// table. SSO alone only proves WHO logged in, not that they're the
// intended curator - that's what the users table lookup is for.

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

const EMAIL_CLAIM_TYPES = new Set(['email', 'emails', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']);

/** Not every identity provider's claim set is guaranteed to include an
 * email claim by default (GitHub in particular requires the user:email
 * scope be requested) - this is an integration point that needs
 * verification once a real provider is wired up, not something that can be
 * confirmed from this codebase alone. */
export function findEmailClaim(principal: ClientPrincipal): string | null {
  const claim = (principal.claims ?? []).find((c) => EMAIL_CLAIM_TYPES.has(c.typ.toLowerCase()));
  return claim ? claim.val : null;
}

export interface AppUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
}

/** Looks up the users row for this principal's email - null if there's no
 * email claim, or no matching row (e.g. GetRoles hasn't run yet for this
 * session; GetRoles is what upserts the row on first sight of a new
 * authenticated user, see handlers/getRoles.ts). */
export async function resolveUser(db: Queryable, principal: ClientPrincipal): Promise<AppUser | null> {
  const email = findEmailClaim(principal);
  if (!email) return null;
  const result = await db.query<{ user_id: string; email: string; display_name: string | null; role: 'curator' | 'volunteer' }>(
    'select user_id, email, display_name, role from users where email = $1',
    [email],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role };
}

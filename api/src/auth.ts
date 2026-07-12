// auth.ts
//
// Parses the x-ms-client-principal header Azure Static Web Apps injects
// into every authenticated request, and resolves it against the users
// table. SSO alone only proves WHO logged in, not that they're the
// intended curator - that's what the users table lookup is for.
//
// Identity is resolved by GitHub username (userDetails), not email.
// Confirmed against current Microsoft Learn docs while prepping for
// deployment: SWA's GitHub provider - default or custom-registered via
// `identityProviders.gitHub` - only ever exposes a username claim, never
// email, and that provider's registration schema has no scope/login
// customization to request one either (unlike the generic OpenID Connect
// provider type). userDetails is always present for an authenticated
// GitHub request, so it's what's used here instead.

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

export interface AppUser {
  userId: string;
  username: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
}

/** Upserts and syncs the users row for this principal's GitHub username -
 * null only when there's no username on the principal at all (an
 * unauthenticated request).
 *
 * Curator role assignment is via Azure Static Web Apps' built-in manual
 * invite flow, not a custom rolesSource function - that feature is
 * Standard-plan-only, and this project is on Free. So `principal.userRoles`
 * (SWA's own server-injected reflection of who an admin has invited to the
 * 'curator' role) is the authoritative source here, synced into the users
 * table on every authenticated request rather than read once at
 * first-sight: an admin revoking curator access in Azure should actually
 * take effect on this user's next request, not just block new grants. */
export async function resolveUser(db: Queryable, principal: ClientPrincipal): Promise<AppUser | null> {
  if (!principal.userDetails) return null;
  const username = principal.userDetails;
  const role: 'curator' | 'volunteer' = principal.userRoles.includes('curator') ? 'curator' : 'volunteer';
  const result = await db.query<{ user_id: string; username: string; display_name: string | null; role: 'curator' | 'volunteer' }>(
    `insert into users (username, display_name, role)
     values ($1, $2, $3)
     on conflict (username) do update set role = excluded.role
     returning user_id, username, display_name, role`,
    [username, username, role],
  );
  const row = result.rows[0];
  return { userId: row.user_id, username: row.username, displayName: row.display_name, role: row.role };
}

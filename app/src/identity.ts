// identity.ts
//
// Reads Azure Static Web Apps' standard /.auth/me endpoint - no custom
// Function needed, SWA provides this automatically once deployed. Mirrors
// api/src/auth.ts's ClientPrincipal shape exactly (both sides parse the
// same SWA-injected identity), so there's one agreed-on shape rather than
// two independently-guessed ones.
//
// Can't be exercised against a real SWA auth session in this environment
// (no Azure deployment exists yet) - the fetch/parse logic here is what's
// verified (component tests mock this response), not the real auth
// handshake itself.

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

interface AuthMeResponse {
  clientPrincipal: ClientPrincipal | null;
}

/** Returns null both for a genuinely anonymous visitor (SWA's own
 * documented response shape: `{ clientPrincipal: null }`) and for a fetch
 * failure - either way, there's no identity to act on, and the caller's
 * job either way is just "show the login link." */
export async function getClientPrincipal(): Promise<ClientPrincipal | null> {
  try {
    const response = await fetch('/.auth/me');
    if (!response.ok) return null;
    const body = (await response.json()) as AuthMeResponse;
    return body.clientPrincipal ?? null;
  } catch {
    return null;
  }
}

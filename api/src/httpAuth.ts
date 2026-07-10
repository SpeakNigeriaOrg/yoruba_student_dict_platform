// httpAuth.ts
//
// HTTP-layer glue around auth.ts's framework-agnostic principal parsing -
// kept separate so auth.ts itself has no dependency on @azure/functions
// and stays unit-testable without constructing a real HttpRequest.

import type { HttpRequest } from '@azure/functions';
import { getPool } from './db.js';
import { parseClientPrincipal, resolveUser, type AppUser } from './auth.js';

export class UnauthenticatedError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'insufficient permissions') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Re-checks the caller's role against the database rather than trusting
 * SWA's own injected userRoles on the header - defense in depth, matching
 * this repo's general "check again server-side, never trust the caller"
 * principle (e.g. Add Phrase's strict component check is enforced
 * server-side too, not just in the UI). */
export async function requireUser(request: HttpRequest): Promise<AppUser> {
  const principal = parseClientPrincipal(request.headers.get('x-ms-client-principal'));
  if (!principal) throw new UnauthenticatedError();
  const user = await resolveUser(getPool(), principal);
  if (!user) throw new UnauthenticatedError('no users row for this principal yet - GetRoles should provision one per session');
  return user;
}

export async function requireCurator(request: HttpRequest): Promise<AppUser> {
  const user = await requireUser(request);
  if (user.role !== 'curator') throw new ForbiddenError('curator role required');
  return user;
}

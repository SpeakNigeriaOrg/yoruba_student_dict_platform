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

/** resolveUser is a lookup against the users table, so this rejects an
 * authenticated principal whose email was never registered - a successful
 * Google login is not by itself authorization (see auth.ts). The
 * roles-source function withholds the 'member' role for the same accounts,
 * making this the server-side half of one gate rather than a second,
 * different rule. */
export async function requireUser(request: HttpRequest): Promise<AppUser> {
  const principal = parseClientPrincipal(request.headers.get('x-ms-client-principal'));
  if (!principal) throw new UnauthenticatedError();
  const user = await resolveUser(getPool(), principal);
  if (!user) throw new UnauthenticatedError('this account is not registered for the platform');
  return user;
}

export async function requireCurator(request: HttpRequest): Promise<AppUser> {
  const user = await requireUser(request);
  if (user.role !== 'curator') throw new ForbiddenError('curator role required');
  return user;
}

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

/** resolveUser upserts/syncs the users row from principal.userRoles (SWA's
 * own reflection of Azure's manual curator-invite state) on every call, so
 * this always returns a user for any authenticated principal. */
export async function requireUser(request: HttpRequest): Promise<AppUser> {
  const principal = parseClientPrincipal(request.headers.get('x-ms-client-principal'));
  if (!principal) throw new UnauthenticatedError();
  const user = await resolveUser(getPool(), principal);
  if (!user) throw new UnauthenticatedError();
  return user;
}

export async function requireCurator(request: HttpRequest): Promise<AppUser> {
  const user = await requireUser(request);
  if (user.role !== 'curator') throw new ForbiddenError('curator role required');
  return user;
}

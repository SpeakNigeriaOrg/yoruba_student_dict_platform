// functions/getRoles.ts
//
// The custom role-source function staticwebapp.config.json's
// auth.rolesSource points at.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { parseClientPrincipal } from '../auth.js';
import { getPool } from '../db.js';
import { getRoles } from '../handlers/getRoles.js';

export async function getRolesFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const principal = parseClientPrincipal(request.headers.get('x-ms-client-principal'));
  const result = await getRoles(getPool(), principal);
  // SWA's documented contract for a custom rolesSource function is a plain
  // JSON array of role name strings as the response body (not wrapped in
  // an object) - unverified against a real deployed instance in this
  // environment (no `func`/SWA CLI available here), so confirm this shape
  // against a real deployment before relying on it.
  return { jsonBody: result.roles };
}

app.http('GetRoles', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'GetRoles',
  handler: getRolesFunction,
});

// functions/getRoles.ts
//
// POST /api/GetRoles - the endpoint staticwebapp.config.json's
// auth.rolesSource names. Invoked by the Static Web Apps platform itself
// after a successful login, NOT by the browser.
//
// Two consequences of that, both load-bearing:
//
//   1. It must NOT be covered by an allowedRoles route rule. Confirmed
//      against current Microsoft docs while building this: a rolesSource
//      endpoint protected by allowedRoles is silently SKIPPED by SWA - no
//      browser error, no function log - which would leave every user with no
//      custom roles and therefore no access to anything. The official sample
//      app has no route rule for it at all, and neither does
//      staticwebapp.config.json here. That is deliberate; do not "secure" it.
//
//   2. It cannot use requireUser/requireCurator. There is no
//      x-ms-client-principal header yet - the principal is what this call is
//      helping to build. The identity arrives in the request BODY instead.
//
// Note that function-based role management is a preview feature and requires
// the Standard plan (see api/README.md).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { getRoles, type RolesRequestBody } from '../handlers/getRoles.js';

export async function getRolesFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await request.json()) as RolesRequestBody | null;
    const result = await getRoles(getPool(), body);
    return { status: 200, jsonBody: result };
  } catch {
    // Never fail the login with a 500: an error here would otherwise block
    // sign-in entirely. Returning no roles degrades to "authenticated but
    // not authorized", which the app already renders sensibly, and which is
    // also the safe direction to fail in.
    return { status: 200, jsonBody: { roles: [] } };
  }
}

app.http('GetRoles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'GetRoles',
  handler: getRolesFunction,
});

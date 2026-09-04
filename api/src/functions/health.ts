// functions/health.ts
//
// GET /api/health - anonymous by design, and the only /api route that is
// meant to be called from outside without a session. See handlers/health.ts
// for why that is necessary rather than merely convenient, and do not add an
// allowedRoles rule for it in staticwebapp.config.json: a deploy check that
// needs a logged-in user cannot run in CI.
//
// 200 when the host is serving and the database answers, 503 when it is not,
// so a status code alone is a usable signal for the workflow's smoke test
// while the body carries the detail for a human.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { health } from '../handlers/health.js';

export async function healthFunction(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const report = await health(getPool());
    return {
      status: report.status === 'ok' ? 200 : 503,
      jsonBody: report,
      // Never let a CDN or browser answer this from cache: a cached 200 from
      // the previous deploy is precisely the lie this endpoint exists to stop.
      headers: { 'Cache-Control': 'no-store' },
    };
  } catch {
    // getPool() throws when DATABASE_URL is unset - a real and silent
    // production misconfiguration, so it must read as unhealthy, not as a 500.
    return {
      status: 503,
      jsonBody: { status: 'degraded', database: 'unreachable', checkedAt: new Date().toISOString() },
      headers: { 'Cache-Control': 'no-store' },
    };
  }
}

app.http('Health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: healthFunction,
});

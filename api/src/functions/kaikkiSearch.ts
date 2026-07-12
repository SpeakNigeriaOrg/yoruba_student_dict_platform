// functions/kaikkiSearch.ts
//
// GET /api/kaikki-search?q=... - any authenticated user (curators AND
// volunteers proposing a spelling/definition contribution both need
// manual lookup when the automatic match is wrong, ambiguous, or missing).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { searchKaikkiHandler } from '../handlers/searchKaikki.js';

export async function kaikkiSearchFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireUser(request);
    const query = request.query.get('q') ?? '';
    const results = await searchKaikkiHandler(getPool(), query);
    return { status: 200, jsonBody: { results } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('KaikkiSearch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'kaikki-search',
  handler: kaikkiSearchFunction,
});

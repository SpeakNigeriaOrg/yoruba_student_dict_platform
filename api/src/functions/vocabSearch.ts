// functions/vocabSearch.ts
//
// GET /api/vocab-search?q=... - any authenticated user (curators
// confirming/adding etymology components, and the Add Word/Phrase screens,
// AND volunteers proposing an etymology contribution all need this).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { searchVocabHandler } from '../handlers/searchVocab.js';

export async function vocabSearchFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireUser(request);
    const query = request.query.get('q') ?? '';
    const results = await searchVocabHandler(getPool(), query);
    return { status: 200, jsonBody: { results } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('VocabSearch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'vocab-search',
  handler: vocabSearchFunction,
});

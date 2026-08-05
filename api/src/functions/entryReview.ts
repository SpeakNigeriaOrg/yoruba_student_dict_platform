// functions/entryReview.ts
//
// GET /api/words/{wordId}/entry - any authenticated user can read
// (volunteers propose contributions on this axis; curators decide
// directly). Writing a decision (POST /decisions/entry) stays curator-only.
//
// Replaces the former words/{wordId}/spelling and words/{wordId}/definition
// routes, which are now one axis - see handlers/getEntryReview.ts.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { getEntryReview } from '../handlers/getEntryReview.js';
import { WordNotFoundError } from '../handlers/errors.js';

export async function entryReviewFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const wordId = request.params.wordId;
    const result = await getEntryReview(getPool(), wordId, user.userId);
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetEntryReview', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/entry',
  handler: entryReviewFunction,
});

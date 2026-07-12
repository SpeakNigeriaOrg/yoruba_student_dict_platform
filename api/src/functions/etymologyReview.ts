// functions/etymologyReview.ts
//
// GET /api/words/{wordId}/etymology - any authenticated user can read
// (volunteers propose contributions on this axis; curators decide
// directly). Writing a decision (POST /decisions/etymology) stays
// curator-only.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { getEtymologyReview } from '../handlers/getEtymologyReview.js';
import { WordNotFoundError } from '../handlers/errors.js';

export async function etymologyReviewFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const wordId = request.params.wordId;
    const result = await getEtymologyReview(getPool(), wordId, user.userId);
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetEtymologyReview', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/etymology',
  handler: etymologyReviewFunction,
});

// functions/definitionReview.ts
//
// GET /api/words/{wordId}/definition - curator-gated, same as the
// write-side decision on this axis (POST /decisions/definition).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { getDefinitionReview } from '../handlers/getDefinitionReview.js';
import { WordNotFoundError } from '../handlers/errors.js';

export async function definitionReviewFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const wordId = request.params.wordId;
    const result = await getDefinitionReview(getPool(), wordId);
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetDefinitionReview', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/definition',
  handler: definitionReviewFunction,
});

// functions/axisStatus.ts
//
// GET /api/words/{wordId}/axis-status - any authenticated user, same gate
// as the three review-axis GET endpoints.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { getAxisStatus } from '../handlers/getAxisStatus.js';
import { WordNotFoundError } from '../handlers/errors.js';

export async function axisStatusFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireUser(request);
    const wordId = request.params.wordId;
    const result = await getAxisStatus(getPool(), wordId);
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetAxisStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/axis-status',
  handler: axisStatusFunction,
});

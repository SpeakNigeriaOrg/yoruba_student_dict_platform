// functions/syllableObservations.ts
//
// GET /api/syllables/{syllableText}/observations - any authenticated
// user, same gate as the other read endpoints (see
// listSyllableObservations.ts's file header for why this is decoupled
// from any single word).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { listSyllableObservations } from '../handlers/listSyllableObservations.js';

export async function listSyllableObservationsFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireUser(request);
    const syllableText = request.params.syllableText;
    const result = await listSyllableObservations(getPool(), syllableText);
    return { status: 200, jsonBody: { observations: result } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListSyllableObservations', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'syllables/{syllableText}/observations',
  handler: listSyllableObservationsFunction,
});

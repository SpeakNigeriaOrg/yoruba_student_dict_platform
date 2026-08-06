// functions/utteranceList.ts
//
// GET /api/words/{wordId}/utterances - any authenticated user, same gate as the review-axis GET
// endpoints.
//
// A volunteer gets their OWN recordings only; a curator gets every speaker's. The role check
// lives here because this is the layer that has the authenticated user - the handler takes a
// flag and stays role-agnostic. See listUtterances.ts's file header for why the scoping is
// server-side rather than a hidden section in the UI.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { listUtterances } from '../handlers/listUtterances.js';
import { WordNotFoundError } from '../handlers/errors.js';

export async function listUtterancesFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const wordId = request.params.wordId;
    const result = await listUtterances(getPool(), wordId, user.userId, {
      includeOtherSpeakers: user.role === 'curator',
    });
    return { status: 200, jsonBody: { utterances: result } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListUtterances', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/utterances',
  handler: listUtterancesFunction,
});

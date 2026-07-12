// functions/duplicateCheck.ts
//
// GET /api/duplicate-check?spelling=...&altOfTargets=a,b,c - curator-gated,
// used by the Add Word screen before submitting POST /api/words.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { checkDuplicatesHandler } from '../handlers/checkDuplicates.js';

export async function duplicateCheckFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const spelling = request.query.get('spelling') ?? '';
    const altOfTargetsParam = request.query.get('altOfTargets') ?? '';
    const altOfTargets = altOfTargetsParam ? altOfTargetsParam.split(',').filter(Boolean) : [];
    const matches = await checkDuplicatesHandler(getPool(), spelling, altOfTargets);
    return { status: 200, jsonBody: { matches } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('DuplicateCheck', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'duplicate-check',
  handler: duplicateCheckFunction,
});

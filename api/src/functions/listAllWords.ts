// functions/listAllWords.ts
//
// GET /api/words - curator-only browse-all-words listing. Distinct
// function registration from CreateWord (functions/words.ts) on the same
// route path - Azure Functions routes by method+path together, so a GET
// here and a POST there coexist cleanly.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { listAllWords } from '../handlers/listAllWords.js';

export async function listAllWordsFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const words = await listAllWords(getPool(), user.userId);
    return { status: 200, jsonBody: { words } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListAllWords', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words',
  handler: listAllWordsFunction,
});

// functions/utteranceSasToken.ts
//
// POST /api/utterances/sas-token - any authenticated user (recording is a
// contribution-adjacent activity, same gate as submitContribution.ts).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { issueUploadSasToken } from '../handlers/issueUploadSasToken.js';

export async function utteranceSasTokenFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireUser(request);
    const body = (await request.json()) as Record<string, unknown> | null;
    const wordId = body && typeof body.wordId === 'string' ? body.wordId : '';
    if (!wordId) throw new Error('wordId is required');
    const result = issueUploadSasToken(wordId);
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('UtteranceSasToken', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'utterances/sas-token',
  handler: utteranceSasTokenFunction,
});

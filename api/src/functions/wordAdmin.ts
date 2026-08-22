// functions/wordAdmin.ts
//
// The two things a curator could not previously do to an entry that already exists:
//
//   GET    /api/words/{wordId}/deletion-impact  - what deleting it would destroy
//   DELETE /api/words/{wordId}[?confirm=true]   - delete it
//   PATCH  /api/words/{wordId}                  - change its word_id, keeping everything
//
// Curator-gated server-side by requireCurator, as well as by staticwebapp.config.json's
// route rule - the config restricts the two mutating methods, and this re-checks because
// a raw API call could bypass the route config entirely. Same belt-and-braces as words.ts.
//
// The impact GET is separate from the DELETE rather than being "a DELETE that refuses",
// so the screen can show what is at stake BEFORE anything destructive is issued. The
// DELETE still refuses on its own (409 + the same impact body) when work is attached and
// confirm is absent, so the safety does not depend on a client having asked first.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { WordIdAlreadyExistsError, WordNotFoundError } from '../handlers/errors.js';
import {
  deleteWord,
  previewWordDeletion,
  WordHasAttachedWorkError,
  WordIsAComponentError,
} from '../handlers/deleteWord.js';
import { IncompleteRenameError, renameWord, SameWordIdError } from '../handlers/renameWord.js';
import { InvalidWordIdError } from '../handlers/wordIdShape.js';
import { UnknownWordIdReferenceError } from '../handlers/wordIdReferences.js';

/** The catch chain every route in this file shares.
 *
 * UnknownWordIdReferenceError and IncompleteRenameError are 500s, not 400s: nothing about
 * the request is wrong, the server's own reference inventory is out of date. Reporting
 * them as client errors would send a curator looking for a mistake they did not make. */
function errorResponse(err: unknown): HttpResponseInit {
  if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
  if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
  if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
  if (err instanceof WordIdAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
  if (err instanceof WordIsAComponentError) {
    return { status: 409, jsonBody: { error: err.message, usedAsComponentOf: err.usedAsComponentOf } };
  }
  // 409 with the impact attached, so a client that skipped the preview still gets the whole
  // answer and can put it in front of a human rather than just retrying with confirm.
  if (err instanceof WordHasAttachedWorkError) {
    return { status: 409, jsonBody: { error: err.message, impact: err.impact, confirmRequired: true } };
  }
  if (err instanceof UnknownWordIdReferenceError || err instanceof IncompleteRenameError) {
    return { status: 500, jsonBody: { error: err.message } };
  }
  if (err instanceof InvalidWordIdError || err instanceof SameWordIdError) {
    return { status: 400, jsonBody: { error: err.message } };
  }
  if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
  throw err;
}

export async function wordDeletionImpactFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const impact = await previewWordDeletion(getPool(), request.params.wordId);
    return { status: 200, jsonBody: impact };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('WordDeletionImpact', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/deletion-impact',
  handler: wordDeletionImpactFunction,
});

export async function deleteWordFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    // A query parameter rather than a body: DELETE with a request body is inconsistently
    // handled by proxies and by fetch itself, and this is one boolean.
    const confirm = request.query.get('confirm') === 'true';
    const impact = await deleteWord(getPool(), request.params.wordId, { confirm });
    return { status: 200, jsonBody: { deleted: impact } };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('DeleteWord', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'words/{wordId}',
  handler: deleteWordFunction,
});

export function parseRenameWordInput(body: unknown): { newWordId: string } {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.newWordId !== 'string' || !b.newWordId) throw new Error('newWordId is required');
  return { newWordId: b.newWordId };
}

export async function renameWordFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const { newWordId } = parseRenameWordInput(await request.json());
    const result = await renameWord(getPool(), request.params.wordId, newWordId, user.userId);
    return { status: 200, jsonBody: result };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('RenameWord', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'words/{wordId}',
  handler: renameWordFunction,
});

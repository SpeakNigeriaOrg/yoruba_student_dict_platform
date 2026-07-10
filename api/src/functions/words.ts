// functions/words.ts
//
// POST /api/words - curator-gated direct insert (see the approved plan's
// "curator-gated authoring" decision). staticwebapp.config.json restricts
// this route to the curator role; requireCurator re-checks it server-side
// too, since a raw API call could bypass the route config.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { createWord, WordIdAlreadyExistsError, type CreateWordInput } from '../handlers/createWord.js';

function parseCreateWordInput(body: unknown): CreateWordInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  if (typeof b.displayText !== 'string' || !b.displayText) throw new Error('displayText is required');
  if (!Array.isArray(b.syllables) || b.syllables.length === 0 || !b.syllables.every((s) => typeof s === 'string')) {
    throw new Error('syllables must be a non-empty array of strings');
  }
  if (b.definition !== undefined && b.definition !== null && typeof b.definition !== 'string') {
    throw new Error('definition must be a string if provided');
  }
  return {
    wordId: b.wordId,
    displayText: b.displayText,
    syllables: b.syllables as string[],
    definition: (b.definition as string | null | undefined) ?? null,
  };
}

export async function createWordFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const input = parseCreateWordInput(await request.json());
    await createWord(getPool(), input, user.userId);
    return { status: 201, jsonBody: { wordId: input.wordId } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordIdAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('CreateWord', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'words',
  handler: createWordFunction,
});

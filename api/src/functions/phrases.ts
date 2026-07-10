// functions/phrases.ts
//
// POST /api/phrases - curator-gated direct insert, same trust model as
// functions/words.ts. Component strictness is enforced by
// createPhrase.ts/the golden_record_components foreign key, not here.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import {
  ComponentsNotFoundError,
  createPhrase,
  NoComponentsError,
  WordIdAlreadyExistsError,
  type CreatePhraseInput,
} from '../handlers/createPhrase.js';

function parseCreatePhraseInput(body: unknown): CreatePhraseInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  if (typeof b.displayText !== 'string' || !b.displayText) throw new Error('displayText is required');
  if (!Array.isArray(b.syllables) || b.syllables.length === 0 || !b.syllables.every((s) => typeof s === 'string')) {
    throw new Error('syllables must be a non-empty array of strings');
  }
  if (!Array.isArray(b.components) || !b.components.every((c) => typeof c === 'string')) {
    throw new Error('components must be an array of word_id strings');
  }
  return {
    wordId: b.wordId,
    displayText: b.displayText,
    syllables: b.syllables as string[],
    components: b.components as string[],
  };
}

export async function createPhraseFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const input = parseCreatePhraseInput(await request.json());
    await createPhrase(getPool(), input, user.userId);
    return { status: 201, jsonBody: { wordId: input.wordId } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordIdAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof NoComponentsError || err instanceof ComponentsNotFoundError) {
      return { status: 400, jsonBody: { error: err.message } };
    }
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('CreatePhrase', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'phrases',
  handler: createPhraseFunction,
});

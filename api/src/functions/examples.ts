// functions/examples.ts
//
// GET  /api/words/{wordId}/examples - every live example of a word in use.
// POST /api/words/{wordId}/examples - contribute your own.
//
// Both member-level, the same gate as the other review-axis endpoints. No route rule is
// needed in staticwebapp.config.json: `/api/words/*` already resolves to `member`, and it
// sits AFTER the curator-only bare `/api/words` rule, so the specific-before-wildcard
// invariant documented in api/README.md is unaffected.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { listExamples } from '../handlers/listExamples.js';
import {
  submitExample,
  ExampleIncompleteError,
  InvalidExampleTypeError,
  type SubmitExampleInput,
  type ExampleType,
} from '../handlers/submitExample.js';
import { WordNotFoundError } from '../handlers/errors.js';
import { excludeExample, ExampleAlreadyExcludedError, ExampleNotFoundError } from '../handlers/excludeExample.js';

function parseSubmitExampleInput(body: unknown): SubmitExampleInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.exampleType !== 'string') throw new Error('exampleType is required');
  if (typeof b.exampleText !== 'string') throw new Error('exampleText must be a string');
  if (typeof b.translation !== 'string') throw new Error('translation must be a string');
  if (typeof b.audioBase64 !== 'string') throw new Error('audioBase64 must be a string');
  // Whether the type is one of the three, and whether the text/translation/audio are
  // actually present, is checked in submitExample - so the rule holds for any caller
  // rather than only for this HTTP edge.
  return {
    exampleType: b.exampleType as ExampleType,
    exampleText: b.exampleText,
    translation: b.translation,
    audioBase64: b.audioBase64,
  };
}

export async function listExamplesFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const examples = await listExamples(getPool(), request.params.wordId, user.userId);
    return { status: 200, jsonBody: { examples } };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function submitExampleFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const input = parseSubmitExampleInput(await request.json());
    const result = await submitExample(getPool(), request.params.wordId, input, user.userId);
    return { status: 201, jsonBody: result };
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): HttpResponseInit {
  if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
  if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
  if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
  if (err instanceof ExampleIncompleteError || err instanceof InvalidExampleTypeError) {
    return { status: 400, jsonBody: { error: err.message } };
  }
  if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
  throw err;
}

app.http('ListExamples', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/examples',
  handler: listExamplesFunction,
});

app.http('SubmitExample', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/examples',
  handler: submitExampleFunction,
});

/** POST /api/examples/{exampleId}/exclude - curator-only moderation.
 *
 * 0015 designed the columns for this and nothing ever wrote them. See excludeExample.ts. */
export async function excludeExampleFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const body = (await request.json()) as Record<string, unknown> | null;
    const reason = body && typeof body.reason === 'string' ? body.reason : '';
    await excludeExample(getPool(), request.params.exampleId, reason, user.userId);
    return { status: 200, jsonBody: { exampleId: request.params.exampleId, status: 'excluded' } };
  } catch (err) {
    if (err instanceof ExampleNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof ExampleAlreadyExcludedError) return { status: 409, jsonBody: { error: err.message } };
    return errorResponse(err);
  }
}

app.http('ExcludeExample', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'examples/{exampleId}/exclude',
  handler: excludeExampleFunction,
});

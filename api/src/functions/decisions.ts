// functions/decisions.ts
//
// POST /api/decisions/{axis} - a curator's direct decision on one of the
// three review axes, applied immediately (content change + word_decisions
// upsert, in one transaction - see the handlers for each axis).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { parseDefinitionInput, parseEtymologyInput, parseSpellingInput } from '../decisionInputParsing.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { applyDefinitionDecision, MissingDefinitionTextError } from '../handlers/applyDefinitionDecision.js';
import {
  applyEtymologyDecision,
  ComponentsNotFoundError,
  ComponentsRequiredError,
} from '../handlers/applyEtymologyDecision.js';
import {
  applySpellingDecision,
  NewDisplayTextRequiredError,
  NoDecisionProvidedError,
} from '../handlers/applySpellingDecision.js';
import { WordNotFoundError } from '../handlers/errors.js';

function requireWordId(b: Record<string, unknown>): string {
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  return b.wordId;
}

export async function decisionsFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const axis = request.params.axis;
  try {
    const user = await requireCurator(request);
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
    const b = body as Record<string, unknown>;
    const wordId = requireWordId(b);

    switch (axis) {
      case 'spelling':
        await applySpellingDecision(getPool(), wordId, parseSpellingInput(b), user.userId);
        break;
      case 'definition':
        await applyDefinitionDecision(getPool(), wordId, parseDefinitionInput(b), user.userId);
        break;
      case 'etymology':
        await applyEtymologyDecision(getPool(), wordId, parseEtymologyInput(b), user.userId);
        break;
      default:
        return { status: 404, jsonBody: { error: `unknown decision axis '${axis}'` } };
    }
    return { status: 200, jsonBody: { wordId, axis } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (
      err instanceof MissingDefinitionTextError ||
      err instanceof ComponentsRequiredError ||
      err instanceof ComponentsNotFoundError ||
      err instanceof NewDisplayTextRequiredError ||
      err instanceof NoDecisionProvidedError
    ) {
      return { status: 400, jsonBody: { error: err.message } };
    }
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('Decisions', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'decisions/{axis}',
  handler: decisionsFunction,
});

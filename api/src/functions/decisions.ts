// functions/decisions.ts
//
// POST /api/decisions/{axis} - a curator's direct decision on one of the
// three review axes, applied immediately (content change + word_decisions
// upsert, in one transaction - see the handlers for each axis).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import {
  applyDefinitionDecision,
  MissingDefinitionTextError,
  type ApplyDefinitionDecisionInput,
} from '../handlers/applyDefinitionDecision.js';
import {
  applyEtymologyDecision,
  ComponentsNotFoundError,
  ComponentsRequiredError,
  type ApplyEtymologyDecisionInput,
} from '../handlers/applyEtymologyDecision.js';
import {
  applySpellingDecision,
  NewDisplayTextRequiredError,
  NoDecisionProvidedError,
  type ApplySpellingDecisionInput,
} from '../handlers/applySpellingDecision.js';
import { WordNotFoundError } from '../handlers/errors.js';

function requireWordId(b: Record<string, unknown>): string {
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  return b.wordId;
}

function parseSpellingInput(b: Record<string, unknown>): ApplySpellingDecisionInput {
  const action = b.action;
  if (action !== undefined && action !== 'keep_ours' && action !== 'select_candidate' && action !== 'adopt_kaikki') {
    throw new Error("action must be one of 'keep_ours', 'select_candidate', 'adopt_kaikki' if provided");
  }
  const syllableAction = b.syllableAction;
  if (syllableAction !== undefined && syllableAction !== 'keep_manual' && syllableAction !== 'accept_programmatic') {
    throw new Error("syllableAction must be one of 'keep_manual', 'accept_programmatic' if provided");
  }
  return {
    action,
    candidateForm: typeof b.candidateForm === 'string' ? b.candidateForm : undefined,
    newDisplayText: typeof b.newDisplayText === 'string' ? b.newDisplayText : undefined,
    syllableAction,
    syllableNote: typeof b.syllableNote === 'string' ? b.syllableNote : undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
}

function parseDefinitionInput(b: Record<string, unknown>): ApplyDefinitionDecisionInput {
  if (b.definitionAction !== 'confirm' && b.definitionAction !== 'custom') {
    throw new Error("definitionAction must be 'confirm' or 'custom'");
  }
  return {
    definitionAction: b.definitionAction,
    definitionText: typeof b.definitionText === 'string' ? b.definitionText : undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
}

const COMPONENTS_ACTIONS = ['confirm_atomic', 'confirm_existing', 'reject_proposed', 'accept_proposed', 'custom'];

function parseEtymologyInput(b: Record<string, unknown>): ApplyEtymologyDecisionInput {
  if (typeof b.componentsAction !== 'string' || !COMPONENTS_ACTIONS.includes(b.componentsAction)) {
    throw new Error(`componentsAction must be one of ${COMPONENTS_ACTIONS.join(', ')}`);
  }
  if (b.components !== undefined && (!Array.isArray(b.components) || !b.components.every((c) => typeof c === 'string'))) {
    throw new Error('components must be an array of word_id strings if provided');
  }
  return {
    componentsAction: b.componentsAction as ApplyEtymologyDecisionInput['componentsAction'],
    components: b.components as string[] | undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
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

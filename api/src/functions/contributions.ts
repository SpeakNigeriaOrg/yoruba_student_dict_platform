// functions/contributions.ts
//
// POST /api/contributions - any authenticated user (curator or
// volunteer) proposes a decision or a new entry; nothing is applied until
// a curator approves it (see functions/approveContribution.ts).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { parseEntryInput, parseEtymologyInput } from '../decisionInputParsing.js';
import { ForbiddenError, requireCurator, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { validateEntryDecisionInput } from '../handlers/applyEntryDecision.js';
import { submitContribution, type NewEntryProposedValue, type SubmitContributionInput } from '../handlers/submitContribution.js';
import { listContributions } from '../handlers/listContributions.js';
import { WordNotFoundError } from '../handlers/errors.js';

function requireWordId(b: Record<string, unknown>): string {
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  return b.wordId;
}

function parseNewEntryInput(b: Record<string, unknown>): NewEntryProposedValue {
  if (typeof b.proposedWordId !== 'string' || !b.proposedWordId) throw new Error('proposedWordId is required');
  if (typeof b.displayText !== 'string' || !b.displayText) throw new Error('displayText is required');
  if (!Array.isArray(b.syllables) || b.syllables.length === 0 || !b.syllables.every((s) => typeof s === 'string')) {
    throw new Error('syllables must be a non-empty array of strings');
  }
  if (b.type !== 'word' && b.type !== 'phrase') throw new Error("type must be 'word' or 'phrase'");
  if (b.components !== undefined && (!Array.isArray(b.components) || !b.components.every((c) => typeof c === 'string'))) {
    throw new Error('components must be an array of word_id strings if provided');
  }
  return {
    proposedWordId: b.proposedWordId,
    displayText: b.displayText,
    syllables: b.syllables as string[],
    type: b.type,
    components: b.components as string[] | undefined,
  };
}

function parseSubmitContributionInput(b: Record<string, unknown>): SubmitContributionInput {
  const note = typeof b.note === 'string' ? b.note : undefined;
  switch (b.axis) {
    case 'entry': {
      // Validated at submission rather than only at approval: a volunteer
      // who proposes half an entry should be told immediately, not have it
      // sit in the queue until a curator hits the same error.
      const proposedValue = parseEntryInput(b);
      validateEntryDecisionInput(proposedValue);
      return { axis: 'entry', wordId: requireWordId(b), proposedValue, note };
    }
    case 'etymology':
      return { axis: 'etymology', wordId: requireWordId(b), proposedValue: parseEtymologyInput(b), note };
    case 'new_entry':
      return { axis: 'new_entry', proposedValue: parseNewEntryInput(b), note };
    default:
      throw new Error("axis must be one of 'entry', 'etymology', 'new_entry'");
  }
}

export async function submitContributionFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
    const input = parseSubmitContributionInput(body as Record<string, unknown>);

    const result = await submitContribution(getPool(), input, user.userId);
    return { status: 201, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('SubmitContribution', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contributions',
  handler: submitContributionFunction,
});

export async function listContributionsFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const status = request.query.get('status') ?? 'pending';
    const contributions = await listContributions(getPool(), status);
    return { status: 200, jsonBody: { contributions } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListContributions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'contributions',
  handler: listContributionsFunction,
});

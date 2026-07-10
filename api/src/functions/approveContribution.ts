// functions/approveContribution.ts
//
// POST /api/contributions/{id}/approve - curator-only.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import {
  approveContribution,
  ContributionAlreadyReviewedError,
  ContributionNotFoundError,
} from '../handlers/approveContribution.js';
import { ComponentsNotFoundError, ComponentsRequiredError } from '../handlers/applyEtymologyDecision.js';
import { MissingDefinitionTextError } from '../handlers/applyDefinitionDecision.js';
import { NewDisplayTextRequiredError, NoDecisionProvidedError } from '../handlers/applySpellingDecision.js';
import { WordIdAlreadyExistsError } from '../handlers/errors.js';

export async function approveContributionFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const contributionId = request.params.id;
  try {
    const user = await requireCurator(request);
    if (!contributionId) throw new Error('contribution id is required in the route');

    await approveContribution(getPool(), contributionId, user.userId);
    return { status: 200, jsonBody: { contributionId, status: 'approved' } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof ContributionNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof WordIdAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
    if (
      err instanceof ContributionAlreadyReviewedError ||
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

app.http('ApproveContribution', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contributions/{id}/approve',
  handler: approveContributionFunction,
});

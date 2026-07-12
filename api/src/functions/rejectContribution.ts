// functions/rejectContribution.ts
//
// POST /api/contributions/{id}/reject - curator-only. Distinct route from
// approve (functions/approveContribution.ts) - a curator explicitly picks
// one or the other, never both.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { ContributionAlreadyReviewedError, ContributionNotFoundError } from '../handlers/approveContribution.js';
import { rejectContribution } from '../handlers/rejectContribution.js';

export async function rejectContributionFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const contributionId = request.params.id;
  try {
    const user = await requireCurator(request);
    if (!contributionId) throw new Error('contribution id is required in the route');

    await rejectContribution(getPool(), contributionId, user.userId);
    return { status: 200, jsonBody: { contributionId, status: 'rejected' } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof ContributionNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof ContributionAlreadyReviewedError) return { status: 400, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('RejectContribution', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contributions/{id}/reject',
  handler: rejectContributionFunction,
});

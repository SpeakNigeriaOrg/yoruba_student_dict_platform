// functions/excludeContribution.ts
//
// POST /api/contributions/{id}/exclude - curator-only. Replaces the former
// .../reject route.
//
// Rejecting was a verdict on a person's submission. Excluding removes a row
// from the consensus TALLY - for spam, abuse, a duplicate account, test data -
// while leaving what it says completely intact. See handlers/
// excludeContribution.ts for why that distinction is the point.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { ContributionNotFoundError } from '../handlers/approveContribution.js';
import { excludeContribution, ContributionNotActiveError } from '../handlers/excludeContribution.js';

export async function excludeContributionFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const contributionId = request.params.id;
  try {
    const user = await requireCurator(request);
    if (!contributionId) throw new Error('contribution id is required in the route');

    const body = await request.json().catch(() => null);
    const reason = body && typeof body === 'object' ? (body as Record<string, unknown>).reason : undefined;
    if (reason !== undefined && typeof reason !== 'string') throw new Error('reason must be a string if provided');

    await excludeContribution(getPool(), contributionId, user.userId, reason);
    return { status: 200, jsonBody: { contributionId, status: 'excluded' } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof ContributionNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof ContributionNotActiveError) return { status: 400, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ExcludeContribution', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contributions/{id}/exclude',
  handler: excludeContributionFunction,
});

// functions/grants.ts
//
// GET  /api/grants/me - what this account has agreed to, and whether to ask.
// POST /api/grants/me - the answer, accepted or declined.
//
// Any authenticated user, curator or volunteer: this is a question about the person's
// own work, not a privileged action, and a curator records and contributes exactly like
// anyone else. Scoped to the caller with no id in the route, so one account can never
// answer for another - the same reason assignments/me has no user id in its path.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { withTransaction } from '../db.js';
import { UnauthenticatedError, requireUser } from '../httpAuth.js';
import {
  getGrantStatus,
  recordContributorGrant,
  TermsVersionMismatchError,
  type RecordGrantInput,
} from '../handlers/contributionGrants.js';

function parseRecordGrantInput(body: unknown): RecordGrantInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.termsVersion !== 'string' || !b.termsVersion) throw new Error('termsVersion is required');

  // The whole wire shape: which wording was on screen, and whether they declined. An
  // acceptance carries nothing else, because the agreement assigns everything and there is
  // no per-person permission for a client to assert.
  if (b.declineReason !== undefined) {
    if (typeof b.declineReason !== 'string') throw new Error('declineReason must be a string');
    return { termsVersion: b.termsVersion, declineReason: b.declineReason };
  }
  return { termsVersion: b.termsVersion };
}

export async function getMyGrantFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    return { status: 200, jsonBody: await getGrantStatus(getPool(), user.userId) };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

export async function recordMyGrantFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    // The one write exempt from the contributor gate, and it has to be: for an account
    // that declined, answering again IS the way back, and the gate would refuse the only
    // request that could lift it.
    const user = await requireUser(request, { allowWithoutGrant: true });
    const input = parseRecordGrantInput(await request.json());
    // One transaction: the acceptance creates the speaker row it names, and a grant
    // pointing at a speaker that was never committed - or a speaker created for an
    // acceptance that then failed - is the kind of half-state this whole table exists
    // to make unrepresentable.
    const status = await withTransaction(getPool(), (client) =>
      recordContributorGrant(client, user.userId, user.displayName ?? user.email, input),
    );
    return { status: 201, jsonBody: status };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    // 409, not 400: the request was well-formed and the client is simply out of date
    // with the wording. The app's response is to reload and show the current terms.
    if (err instanceof TermsVersionMismatchError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetMyGrant', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'grants/me',
  handler: getMyGrantFunction,
});

app.http('RecordMyGrant', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'grants/me',
  handler: recordMyGrantFunction,
});

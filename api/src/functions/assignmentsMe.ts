// functions/assignmentsMe.ts
//
// GET /api/assignments/me - any authenticated user.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { listMyAssignments } from '../handlers/listMyAssignments.js';
import { UnauthenticatedError, requireUser } from '../httpAuth.js';

export async function listMyAssignmentsFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const assignments = await listMyAssignments(getPool(), user.userId);
    return { status: 200, jsonBody: assignments };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListMyAssignments', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'assignments/me',
  handler: listMyAssignmentsFunction,
});

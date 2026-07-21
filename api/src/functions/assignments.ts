// functions/assignments.ts
//
// Curator-only admin assignment management, separate from
// assignmentsMe.ts's own read-only "my assignments" self-view:
//   GET    /api/assignments/{userId}          - one user's assigned words + status
//   POST   /api/assignments                   - assign word(s) to a user (single or bulk)
//   DELETE /api/assignments/{userId}/{wordId}  - unassign one word from a user

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { listUserAssignments } from '../handlers/listUserAssignments.js';
import { createAssignments, type CreateAssignmentsInput } from '../handlers/createAssignments.js';
import { deleteAssignment } from '../handlers/deleteAssignment.js';
import { AssignmentNotFoundError, UserNotFoundError, WordIdsNotFoundError } from '../handlers/errors.js';

export async function listUserAssignmentsFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const userId = request.params.userId;
    const assignments = await listUserAssignments(getPool(), userId);
    return { status: 200, jsonBody: { assignments } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UserNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListUserAssignments', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'assignments/{userId}',
  handler: listUserAssignmentsFunction,
});

function parseCreateAssignmentsInput(body: unknown): CreateAssignmentsInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.userId !== 'string' || !b.userId) throw new Error('userId is required');
  if (!Array.isArray(b.wordIds) || b.wordIds.length === 0 || !b.wordIds.every((w) => typeof w === 'string')) {
    throw new Error('wordIds must be a non-empty array of strings');
  }
  return { userId: b.userId, wordIds: b.wordIds as string[] };
}

export async function createAssignmentsFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const input = parseCreateAssignmentsInput(await request.json());
    const result = await createAssignments(getPool(), input, user.userId);
    return { status: 201, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UserNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof WordIdsNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('CreateAssignments', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'assignments',
  handler: createAssignmentsFunction,
});

export async function deleteAssignmentFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const userId = request.params.userId;
    const wordId = request.params.wordId;
    await deleteAssignment(getPool(), userId, wordId);
    return { status: 200, jsonBody: { userId, wordId, status: 'unassigned' } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof AssignmentNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('DeleteAssignment', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'assignments/{userId}/{wordId}',
  handler: deleteAssignmentFunction,
});

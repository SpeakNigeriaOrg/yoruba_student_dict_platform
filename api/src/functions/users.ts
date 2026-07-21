// functions/users.ts
//
// GET /api/users - list all user accounts + assignment summary counts.
// POST /api/users - pre-register a user account by username, ahead of
// their first login (see createUser.ts's header for the curator-role
// caveat). Both curator-only.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { listUsers } from '../handlers/listUsers.js';
import { createUser, type CreateUserInput } from '../handlers/createUser.js';
import { UsernameAlreadyExistsError } from '../handlers/errors.js';

export async function listUsersFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const users = await listUsers(getPool());
    return { status: 200, jsonBody: { users } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListUsers', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'users',
  handler: listUsersFunction,
});

function parseCreateUserInput(body: unknown): CreateUserInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.username !== 'string' || !b.username) throw new Error('username is required');
  if (b.displayName !== undefined && b.displayName !== null && typeof b.displayName !== 'string') {
    throw new Error('displayName must be a string if provided');
  }
  if (b.role !== 'curator' && b.role !== 'volunteer') throw new Error("role must be 'curator' or 'volunteer'");
  return {
    username: b.username,
    displayName: (b.displayName as string | null | undefined) ?? null,
    role: b.role,
  };
}

export async function createUserFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const input = parseCreateUserInput(await request.json());
    const user = await createUser(getPool(), input);
    return { status: 201, jsonBody: user };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UsernameAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('CreateUser', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'users',
  handler: createUserFunction,
});

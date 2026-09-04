// functions/users.ts
//
// GET /api/users - list all user accounts + assignment summary counts.
// POST /api/users - pre-register a user account by username, ahead of
// their first login (see createUser.ts's header for the curator-role
// caveat). Both curator-only.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { listUsers } from '../handlers/listUsers.js';
import { createUser, type CreateUserInput } from '../handlers/createUser.js';
import {
  CannotChangeOwnEmailError,
  CannotDemoteLastCuratorError,
  updateUser,
  type UpdateUserInput,
} from '../handlers/updateUserRole.js';
import { loadUserDossier } from '../handlers/userDossier.js';
import { ContributionNotFoundError, loadUserContribution } from '../handlers/userContribution.js';
import { EmailAlreadyExistsError, UserNotFoundError } from '../handlers/errors.js';

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
  if (typeof b.email !== 'string' || !b.email) throw new Error('email is required');
  // Shape-checked, not verified: this is the address a curator is inviting,
  // and Google is what actually proves ownership of it at login. The check
  // exists to catch a GitHub handle or a typo pasted into the field, since
  // such a row would silently never match any login.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) {
    throw new Error('email must be a valid email address');
  }
  if (b.displayName !== undefined && b.displayName !== null && typeof b.displayName !== 'string') {
    throw new Error('displayName must be a string if provided');
  }
  if (b.role !== 'curator' && b.role !== 'volunteer') throw new Error("role must be 'curator' or 'volunteer'");
  return {
    email: b.email,
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
    if (err instanceof EmailAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
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

/** A PATCH body, where absent means "leave alone" and null (displayName only) means clear.
 *
 * Validates the email exactly as createUser does, and for its reason: this is the address a
 * curator is pointing the account at, and Google is what actually proves ownership of it.
 * The check catches a handle or a typo pasted into the field - a row that would then match
 * no login at all. */
function parseUpdateUserInput(body: unknown): UpdateUserInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  const input: UpdateUserInput = {};

  if (b.role !== undefined) {
    if (b.role !== 'curator' && b.role !== 'volunteer') throw new Error("role must be 'curator' or 'volunteer'");
    input.role = b.role;
  }
  if (b.email !== undefined) {
    if (typeof b.email !== 'string' || !b.email.trim()) throw new Error('email must be a non-empty string');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) {
      throw new Error('email must be a valid email address');
    }
    input.email = b.email;
  }
  if (b.displayName !== undefined) {
    if (b.displayName !== null && typeof b.displayName !== 'string') {
      throw new Error('displayName must be a string or null');
    }
    input.displayName = b.displayName as string | null;
  }

  if (input.role === undefined && input.email === undefined && input.displayName === undefined) {
    throw new Error('nothing to update: pass at least one of role, email, displayName');
  }
  return input;
}

export async function updateUserRoleFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const actor = await requireCurator(request);
    const userId = request.params.userId;
    if (!userId) throw new Error('userId is required in the route');
    const input = parseUpdateUserInput(await request.json());

    // The actor is passed so the handler can refuse a curator editing their OWN email -
    // see CannotChangeOwnEmailError for why that one is a lockout rather than a mistake.
    const user = await updateUser(getPool(), userId, input, actor.userId);
    return { status: 200, jsonBody: user };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UserNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof EmailAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof CannotDemoteLastCuratorError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof CannotChangeOwnEmailError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('UpdateUserRole', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'users/{userId}',
  handler: updateUserRoleFunction,
});

/** GET /api/users/{userId} - everything held about one account.
 *
 * Shares its route with the PATCH above, distinguished by method, the same way
 * /api/words/* already splits GET from PATCH/DELETE. Covered by the existing
 * "/api/users/*" curator-only rule in staticwebapp.config.json, so no route rule changes.
 */
export async function getUserFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const userId = request.params.userId;
    if (!userId) throw new Error('userId is required in the route');
    const dossier = await loadUserDossier(getPool(), userId, CONTRIBUTOR_TERMS_VERSION);
    return { status: 200, jsonBody: dossier };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UserNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetUser', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'users/{userId}',
  handler: getUserFunction,
});

/** GET /api/users/{userId}/contributions/{contributionId} - one person's work on one word.
 *
 * Read-only, and curator-only like its siblings: it carries other people's unpublished
 * recordings and examples in full, which is exactly what the "/api/users/*" rule in
 * staticwebapp.config.json already gates. No route rule changes.
 *
 * Scoped by BOTH ids on purpose - see the handler. A contribution id that exists but
 * belongs to another account 404s here rather than rendering under the wrong name.
 */
export async function getUserContributionFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const userId = request.params.userId;
    const contributionId = request.params.contributionId;
    if (!userId) throw new Error('userId is required in the route');
    if (!contributionId) throw new Error('contributionId is required in the route');
    const detail = await loadUserContribution(getPool(), userId, contributionId);
    return { status: 200, jsonBody: detail };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UserNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof ContributionNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('GetUserContribution', {
  methods: ['GET'],
  authLevel: 'anonymous',
  // Deliberately NOT users/{userId}/contributions/{contributionId}, which is what this
  // started as. That four-segment route deployed green and left the whole Function app
  // unindexed - every /api/* route 404ing, twice, reproducibly (runs #82-#85 and #88),
  // while the same bundle indexes all 46 functions under a local Functions host. Nothing
  // else in the app has a four-segment route. Flattened until that is understood.
  route: 'user-contributions/{userId}/{contributionId}',
  handler: getUserContributionFunction,
});

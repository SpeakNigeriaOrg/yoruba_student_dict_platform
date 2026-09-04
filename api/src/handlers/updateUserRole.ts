// handlers/updateUserRole.ts
//
// Backs PATCH /api/users/{userId} - curator-only edits to one account: its role, its email,
// its display name.
//
// It began as promote/demote only, which left the two fields a curator most often needs to
// FIX unfixable. An invite is typed by hand before the person has ever logged in
// (createUser.ts is the access gate), so a typo in the email is both easy to make and
// silently fatal: getRoles withholds every role from an address with no users row, so the
// invitee authenticates successfully and reaches nothing, and the account they were given
// can never be reached by anyone. The only repair was direct SQL.
//
// Changing the email is safe for their WORK, which is the thing that would make it
// dangerous. user_id is the uuid every other table references - contributions,
// assignments, decisions, grants, utterances - so the address is only the login handle.
// Editing it re-points which Google identity may sign in as this account and moves nothing
// else.
//
// This endpoint only became possible with the move to the Standard plan.
// Before, users.role was overwritten from principal.userRoles on every
// request, so writing it here would have been pointless - the next request
// would undo it, and the real change had to be made in the Azure Portal's
// manual-invite flow. Now handlers/getRoles.ts reads users.role, so this IS
// the role mechanism.
//
// The change takes effect on the user's next login rather than their next
// request, because SWA caches the roles it got from the roles-source function
// into the session token. Worth knowing when verifying: a demotion is not
// instant. requireCurator still re-reads the database on every request, so a
// demoted curator loses API access as soon as their token is refreshed, and
// cannot act as a curator server-side even while a stale token claims it.

import { isUniqueViolation, type Queryable } from '../db.js';
import { EmailAlreadyExistsError, UserNotFoundError } from './errors.js';

/** Every field optional and at least one required - a PATCH, so an omitted field means
 * "leave it alone" rather than "set it to null". displayName is the one field that can be
 * deliberately CLEARED, so it distinguishes undefined from null. */
export interface UpdateUserInput {
  role?: 'curator' | 'volunteer' | 'observer';
  email?: string;
  displayName?: string | null;
}

export interface UpdatedUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: 'curator' | 'volunteer' | 'observer';
}

export class CannotDemoteLastCuratorError extends Error {
  constructor() {
    super('cannot demote the last curator - promote another curator first');
    this.name = 'CannotDemoteLastCuratorError';
  }
}

/** The email analogue of the last-curator guard, and needed for the same reason.
 *
 * A curator who edits their OWN address keeps working for the rest of the session -
 * requireCurator resolves the user from the token's email, which still matches until the
 * token is refreshed - and is then locked out at their next login, because getRoles will
 * find no users row for the Google identity they actually sign in with. The failure is
 * delayed, silent, and unrecoverable without direct SQL, which is the worst possible shape.
 *
 * Another curator can still do it for them, which is the honest route: it needs someone who
 * will still be able to log in afterwards. */
export class CannotChangeOwnEmailError extends Error {
  constructor() {
    super(
      'cannot change your own email address - you would be locked out at your next sign-in. ' +
        'Ask another curator to change it for you.',
    );
    this.name = 'CannotChangeOwnEmailError';
  }
}

export async function updateUser(
  db: Queryable,
  userId: string,
  input: UpdateUserInput,
  /** The curator making the change, for the self-lockout guard. Optional so the role-only
   * callers that predate this - and the tests for them - need not thread it through. */
  actingUserId?: string,
): Promise<UpdatedUser> {
  if (input.role === undefined && input.email === undefined && input.displayName === undefined) {
    throw new Error('nothing to update: pass at least one of role, email, displayName');
  }

  if (input.email !== undefined && actingUserId !== undefined && actingUserId === userId) {
    throw new CannotChangeOwnEmailError();
  }

  // Guards against locking the platform out of its own administration:
  // curator is the only role that can grant curator, so demoting the last one
  // would leave no way back in except direct SQL. Checked before the update
  // rather than after, and scoped to the row actually changing.
  if (input.role === 'volunteer') {
    const current = await db.query<{ role: string }>('select role from users where user_id = $1', [userId]);
    if (current.rows.length === 0) throw new UserNotFoundError(userId);
    if (current.rows[0].role === 'curator') {
      const curators = await db.query<{ count: string }>("select count(*) as count from users where role = 'curator'");
      if (Number(curators.rows[0].count) <= 1) throw new CannotDemoteLastCuratorError();
    }
  }

  // Built from the fields actually present, so an omitted one is never written. coalesce
  // would be wrong here: it cannot express clearing display_name back to null.
  const sets: string[] = [];
  const params: unknown[] = [userId];
  if (input.role !== undefined) sets.push(`role = $${params.push(input.role)}`);
  if (input.email !== undefined) {
    // Lowercased and trimmed exactly as createUser does, because resolveUser and getRoles
    // both look up on lower(email) - a row stored in the case a curator happened to type
    // would simply never match a login.
    sets.push(`email = $${params.push(input.email.trim().toLowerCase())}`);
  }
  if (input.displayName !== undefined) {
    const trimmed = input.displayName === null ? null : input.displayName.trim();
    // An empty string is a cleared name, not a name. Stored as null so "no display name"
    // has one representation and the email fallback everywhere else keeps working.
    sets.push(`display_name = $${params.push(trimmed === '' ? null : trimmed)}`);
  }

  let result;
  try {
    result = await db.query<{
      user_id: string;
      email: string;
      display_name: string | null;
      role: 'curator' | 'volunteer';
    }>(
      `update users set ${sets.join(', ')} where user_id = $1
       returning user_id, email, display_name, role`,
      params,
    );
  } catch (err) {
    // users.email is `not null unique`, and the collision is the ordinary mistake here:
    // correcting a typo towards an address someone else already holds.
    if (isUniqueViolation(err)) throw new EmailAlreadyExistsError(input.email!.trim().toLowerCase());
    throw err;
  }

  const row = result.rows[0];
  if (!row) throw new UserNotFoundError(userId);
  return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role };
}

/** The role-only entry point this file began as. Kept because it is what the existing
 * callers and tests use, and because "promote/demote" is a distinct act worth naming. */
export async function updateUserRole(
  db: Queryable,
  userId: string,
  input: { role: 'curator' | 'volunteer' },
): Promise<UpdatedUser> {
  return updateUser(db, userId, { role: input.role });
}

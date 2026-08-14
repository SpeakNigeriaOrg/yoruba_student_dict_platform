// httpAuth.ts
//
// HTTP-layer glue around auth.ts's framework-agnostic principal parsing -
// kept separate so auth.ts itself has no dependency on @azure/functions
// and stays unit-testable without constructing a real HttpRequest.

import type { HttpRequest } from '@azure/functions';
import { blocksContribution } from '@yoruba-student-dict-platform/shared';
import { getPool } from './db.js';
import { parseClientPrincipal, resolveUser, type AppUser } from './auth.js';

export class UnauthenticatedError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'insufficient permissions') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Extends ForbiddenError deliberately, and that is what makes this cheap.
 *
 * Every route file already ends in the same catch chain - UnauthenticatedError -> 401,
 * ForbiddenError -> 403, Error -> 400 - so a subclass lands as a 403 carrying this message
 * through all twenty-odd of them with no route touched. A new error class would have meant
 * editing every one, and the one that got missed would return 400 "insufficient
 * permissions", which reads as a malformed request. */
export class ContributionsPausedError extends ForbiddenError {
  constructor(public readonly releaseState: string) {
    super(
      releaseState === 'revoked'
        ? 'contributions are paused because this account withdrew its contributor agreement - reopen it to continue'
        : 'contributions are paused because this account declined the contributor agreement - agree to continue',
    );
    this.name = 'ContributionsPausedError';
  }
}

export interface RequireUserOptions {
  /** Lets a write through without a contributor agreement. Exactly one endpoint needs it -
   * POST /api/grants/me, the agreement itself. Without the exemption a declined account
   * could never change its mind: the only way back is a write, and the gate below would
   * refuse it. A dead end reachable by pressing the honest button. */
  allowWithoutGrant?: boolean;
}

/** resolveUser is a lookup against the users table, so this rejects an
 * authenticated principal whose email was never registered - a successful
 * Google login is not by itself authorization (see auth.ts). The
 * roles-source function withholds the 'member' role for the same accounts,
 * making this the server-side half of one gate rather than a second,
 * different rule.
 *
 * ---------------------------------------------------------------------------
 * Where the contributor agreement is enforced, and why it is here
 * ---------------------------------------------------------------------------
 * Someone who declined (or withdrew) may not contribute. That could have been a check
 * added to each write handler, which is a dozen files and a permanent invitation to
 * forget one - and the one forgotten would be silent, since a missing check looks
 * exactly like a passing one.
 *
 * Every authenticated write in this API already passes through this function, so the
 * rule goes here once and reaches all of them, including any written later. The method
 * is what distinguishes a contribution from a look: a GET is reading the dictionary,
 * which a declined account keeps doing, and anything else produces or changes content.
 *
 * getRoles is the endpoint that would have made this dangerous - it is a POST, and
 * blocking it would strip a declined user's roles and lock them out of the app
 * entirely rather than out of contributing. It cannot use this function at all (the
 * principal is what that call is helping to build), so it is out of reach by
 * construction rather than by an exception someone has to maintain.
 */
export async function requireUser(request: HttpRequest, options: RequireUserOptions = {}): Promise<AppUser> {
  const principal = parseClientPrincipal(request.headers.get('x-ms-client-principal'));
  if (!principal) throw new UnauthenticatedError();
  const user = await resolveUser(getPool(), principal);
  if (!user) throw new UnauthenticatedError('this account is not registered for the platform');

  if (request.method !== 'GET' && !options.allowWithoutGrant) {
    await requireContributionRights(user);
  }
  return user;
}

/** Refuses a write from an account whose own answer says not to publish its work.
 *
 * Reads contributor_release_rights, which is 0019's single definition of what a grant
 * amounts to - never contribution_grants directly, or this would be a second place the
 * most-recent-statement rule is decided.
 *
 * Only 'declined' and 'revoked' block, per shared/'s BLOCKING_RELEASE_STATES. In
 * particular 'unknown' does not: someone nobody has asked yet is not someone who said no,
 * and blocking them would turn a lookup failure - or simply being ahead of the paperwork -
 * into a stopped day's work. */
async function requireContributionRights(user: AppUser): Promise<void> {
  const { rows } = await getPool().query<{ release_state: string }>(
    'select release_state from contributor_release_rights where user_id = $1',
    [user.userId],
  );
  const state = rows[0]?.release_state ?? 'unknown';
  if (blocksContribution(state)) throw new ContributionsPausedError(state);
}

export async function requireCurator(request: HttpRequest, options: RequireUserOptions = {}): Promise<AppUser> {
  // Inherits the agreement gate through requireUser: a curator's decisions and definitions
  // are authored content too, and 0019 makes no distinction by role about whose work may
  // be published.
  const user = await requireUser(request, options);
  if (user.role !== 'curator') throw new ForbiddenError('curator role required');
  return user;
}

// functions/recentWords.ts
//
// GET /api/recent-words?userId=...&limit=... - curator-only. The newest
// entries, flagged with what {userId} already has, for the assignment
// dialog's "browse recently added" list.
//
// A top-level route rather than words/recent: wordAdmin.ts already owns
// GET words/{wordId}, and a literal segment sharing a position with a route
// parameter is an ambiguity worth not having. `vocab-search` sets the
// precedent for a top-level kebab-case read.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { listRecentWords, RECENT_WORDS_DEFAULT_LIMIT } from '../handlers/listRecentWords.js';
import { UserNotFoundError } from '../handlers/errors.js';

export async function recentWordsFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const userId = request.query.get('userId');
    if (!userId) throw new Error('userId is required');
    const rawLimit = request.query.get('limit');
    // Rejected rather than clamped: a limit that didn't parse means the caller
    // asked for something it thinks it understands, and silently substituting a
    // different number is how a browse quietly stops showing the whole batch.
    // Out-of-range values ARE clamped, in the handler - that is a bound, not a
    // misunderstanding.
    let limit = RECENT_WORDS_DEFAULT_LIMIT;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isFinite(limit)) throw new Error('limit must be a number');
    }
    const words = await listRecentWords(getPool(), userId, limit);
    return { status: 200, jsonBody: { words } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof UserNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('RecentWords', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'recent-words',
  handler: recentWordsFunction,
});

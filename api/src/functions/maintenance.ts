// functions/maintenance.ts
//
// POST /api/maintenance/authoring-votes - curator-only one-off repairs that a
// curator would otherwise have to run from a shell with a production
// DATABASE_URL in their environment. That is the thing being avoided here: the
// script exists and works, but running it means pasting a live connection
// string into a terminal, and the safest version of a dangerous operation is
// the one nobody has to hold the credentials to perform.
//
// `apply` is opt-in per request. Absent or false plans and returns counts
// without writing, which is what the screen's preview uses.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import {
  applyAuthoringVoteBackfill,
  planAuthoringVoteBackfill,
  type BackfillPlan,
} from '../handlers/backfillAuthoringVotes.js';

/** Counts rather than the item lists. The plan is thousands of rows on a real
 * corpus, and the screen shows totals per axis and per skip reason - shipping
 * every word_id so the client could length() it would be a megabyte to render
 * a handful of numbers. */
function summarize(plan: BackfillPlan) {
  const bucket = (reason: string) => plan.skipped.filter((s) => s.reason === reason).length;
  return {
    planned: plan.planned.length,
    plannedEntry: plan.planned.filter((p) => p.axis === 'entry').length,
    plannedEtymology: plan.planned.filter((p) => p.axis === 'etymology').length,
    skippedNoComponents: bucket('no_components'),
    skippedAlreadyVoted: bucket('already_voted'),
    skippedAlreadyDecided: bucket('already_decided'),
  };
}

export async function backfillAuthoringVotesFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const body = (await request.json().catch(() => ({}))) as { apply?: unknown };
    const apply = body?.apply === true;

    const pool = getPool();
    // Attributed to whoever pressed the button. Unlike the script's --by, there is no choice to
    // make: the person authorising the backfill is the person whose position it records, and an
    // endpoint that let a curator file votes under someone else's name would be a worse tool.
    const plan = await planAuthoringVoteBackfill(pool, user.userId);
    if (!apply) {
      return { status: 200, jsonBody: { applied: false, ...summarize(plan) } };
    }

    const result = await applyAuthoringVoteBackfill(pool, user.userId, plan);
    return {
      status: 200,
      jsonBody: {
        applied: true,
        ...summarize(plan),
        written: result.written,
        failed: result.failed.map((f) => ({ wordId: f.wordId, axis: f.axis, error: f.error })),
      },
    };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('BackfillAuthoringVotes', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'maintenance/authoring-votes',
  handler: backfillAuthoringVotesFunction,
});

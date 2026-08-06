// functions/upstreamDrift.ts
//
// GET  /api/upstream-drift        - which cited entries Wiktionary has moved under.
// POST /api/upstream-drift/repin  - re-pin one word, optionally re-linking it to a
//                                   different etymology.
//
// Curator-only. The GET is read-only and safe to call at any time; nothing about
// looking for drift changes anything.
//
// The POST is the whole set of curator responses to drift, and there are only
// three, all of them expressible as one re-pin:
//
//   accept upstream's new content   re-pin the same entryId, taking a fresh copy
//   keep ours                       re-pin the same entryId (the overrides on
//                                   golden_record are untouched either way - a pin
//                                   records what UPSTREAM said, never what we say)
//   re-link                         re-pin a different entryId
//
// That "keep ours" and "accept theirs" are the same operation is not a shortcut.
// The pin is not our claim about the word, it is our record of what upstream said
// when a human last looked. Bringing it up to date is agreeing about upstream, not
// agreeing with upstream.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool, withTransaction } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { reconcileUpstream } from '../handlers/reconcileUpstream.js';
import { writeCitationInTransaction } from '../handlers/upstreamCitations.js';

export async function listUpstreamDriftFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const result = await reconcileUpstream(getPool());
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

export async function repinUpstreamFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const body = (await request.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
    if (typeof body.wordId !== 'string' || !body.wordId) throw new Error('wordId is required');
    if (typeof body.entryId !== 'string' || !body.entryId) {
      throw new Error('entryId is required - name the etymology this word cites, even when it is the same one');
    }

    await withTransaction(getPool(), (client) =>
      writeCitationInTransaction(client, body.wordId as string, { entryId: body.entryId as string }, user.userId),
    );
    return { status: 200, jsonBody: { wordId: body.wordId, entryId: body.entryId } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListUpstreamDrift', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'upstream-drift',
  handler: listUpstreamDriftFunction,
});

app.http('RepinUpstream', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'upstream-drift/repin',
  handler: repinUpstreamFunction,
});

// functions/consensus.ts
//
// GET  /api/consensus         - the curator review queue, one row per
//                               (word, axis), bucketed by what needs attention.
// POST /api/consensus/confirm - promote the volunteer consensus on one or many
//                               (word, axis) pairs to the golden record.
//
// Both curator-only. Together these replace the per-contribution approve/reject
// queue: the curator ratifies the synthesis, not individual people.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import type { ConsensusBucket } from '@yoruba-student-dict-platform/shared';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { listConsensus } from '../handlers/listConsensus.js';
import { confirmConsensus, type ConfirmConsensusItem } from '../handlers/confirmConsensus.js';
import { WordNotFoundError } from '../handlers/errors.js';
import type { DecisionAxis } from '../reviewShared.js';

const BUCKETS: ConsensusBucket[] = ['contested', 'dissent_on_golden', 'ready', 'single', 'golden', 'none'];
const AXES: DecisionAxis[] = ['entry', 'etymology'];

export async function listConsensusFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);

    const bucketParam = request.query.get('buckets');
    const buckets = bucketParam
      ? bucketParam
          .split(',')
          .map((b) => b.trim())
          .filter((b): b is ConsensusBucket => (BUCKETS as string[]).includes(b))
      : undefined;
    if (bucketParam && (!buckets || buckets.length === 0)) {
      throw new Error(`buckets must be a comma-separated subset of: ${BUCKETS.join(', ')}`);
    }

    const axisParam = request.query.get('axis');
    if (axisParam && !(AXES as string[]).includes(axisParam)) {
      throw new Error(`axis must be one of: ${AXES.join(', ')}`);
    }

    const groups = await listConsensus(getPool(), {
      ...(buckets ? { buckets } : {}),
      ...(axisParam ? { axis: axisParam as DecisionAxis } : {}),
    });
    return { status: 200, jsonBody: { groups } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ListConsensus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'consensus',
  handler: listConsensusFunction,
});

function parseConfirmItems(body: unknown): ConfirmConsensusItem[] {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const raw = (body as Record<string, unknown>).items;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('items must be a non-empty array');

  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('each item must be an object');
    const e = entry as Record<string, unknown>;
    if (typeof e.wordId !== 'string' || !e.wordId) throw new Error('each item needs a wordId');
    if (e.axis !== 'entry' && e.axis !== 'etymology') throw new Error("each item's axis must be 'entry' or 'etymology'");
    if (e.expectedFingerprint !== undefined && typeof e.expectedFingerprint !== 'string') {
      throw new Error('expectedFingerprint must be a string if provided');
    }
    return {
      wordId: e.wordId,
      axis: e.axis,
      ...(typeof e.expectedFingerprint === 'string' ? { expectedFingerprint: e.expectedFingerprint } : {}),
      ...(typeof e.note === 'string' ? { note: e.note } : {}),
    };
  });
}

export async function confirmConsensusFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const items = parseConfirmItems(await request.json());
    const result = await confirmConsensus(getPool(), { items }, user.userId);

    // 200 even when some items were skipped. Partial success is the designed
    // behaviour for a bulk confirm - one word gaining a dissenting vote a
    // minute ago must not discard the other 39 - so the per-item outcome is in
    // the body rather than the status code.
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ConfirmConsensus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'consensus/confirm',
  handler: confirmConsensusFunction,
});

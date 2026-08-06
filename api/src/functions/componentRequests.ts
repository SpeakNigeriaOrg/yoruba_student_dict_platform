// functions/componentRequests.ts
//
// POST /api/component-requests - "the part I mean is this Wiktionary etymology; give me a
// word_id I can point at". Resolves to an existing word, or queues a request for the curators.
//
// Member-level: this is the volunteer's route out of the etymology axis's dead end. Needs a
// route rule in staticwebapp.config.json - the path is new and matches no existing pattern.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool, withTransaction } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import {
  requestUnlistedComponent,
  resolveOrRequestComponent,
  WordAlreadyInDictionaryError,
} from '../handlers/resolveOrRequestComponent.js';
import { EntryIdNotCitableError, EntryIdNotInCorpusError } from '../handlers/upstreamCitations.js';

export async function resolveOrRequestComponentFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');

    const hasEntryId = typeof body.entryId === 'string' && body.entryId !== '';
    const hasDisplayText = typeof body.displayText === 'string' && body.displayText !== '';
    // XOR, and enforced rather than resolved by precedence: a body carrying both is a caller
    // that does not know which path it is on, and picking one for it would hide that.
    if (hasEntryId === hasDisplayText) {
      throw new Error('send either entryId (a Wiktionary etymology) or displayText + definition (a word it lacks)');
    }

    // Transactional: the lookups and the contribution insert must agree about production, or
    // two volunteers requesting the same word at once could each create a request.
    const result = await withTransaction(getPool(), (client) =>
      hasEntryId
        ? resolveOrRequestComponent(client, body.entryId as string, user.userId)
        : requestUnlistedComponent(
            client,
            { displayText: body.displayText as string, definition: String(body.definition ?? '') },
            user.userId,
          ),
    );
    return { status: 200, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof EntryIdNotInCorpusError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof EntryIdNotCitableError) return { status: 400, jsonBody: { error: err.message } };
    if (err instanceof WordAlreadyInDictionaryError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('ResolveOrRequestComponent', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'component-requests',
  handler: resolveOrRequestComponentFunction,
});

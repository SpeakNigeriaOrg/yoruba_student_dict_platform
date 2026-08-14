// functions/phrases.ts
//
// POST /api/phrases - curator-gated direct insert, same trust model as
// functions/words.ts. Component strictness is enforced by
// createPhrase.ts/the golden_record_components foreign key, not here.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import {
  ComponentsNotFoundError,
  createPhrase,
  NoComponentsError,
  WordIdAlreadyExistsError,
  type CreatePhraseInput,
} from '../handlers/createPhrase.js';
import { EntryAlreadyCitedError } from '../handlers/upstreamCitations.js';
import { parsePublicationFields } from '../handlers/publicationFields.js';

/** A phrase may cite an etymology but never claim the exemption - createPhrase decides that itself,
 * from whether a citation was supplied. Accepting `exemptReason` on the wire would let a caller
 * declare a phrase exempt while upstream really does have an entry for it. */
function parseEntryIdCitation(raw: unknown): { entryId: string } {
  if (!raw || typeof raw !== 'object') throw new Error('citation must be an object with an entryId');
  const c = raw as Record<string, unknown>;
  if (typeof c.entryId !== 'string' || !c.entryId) throw new Error('citation.entryId is required');
  return { entryId: c.entryId };
}

function parseCreatePhraseInput(body: unknown): CreatePhraseInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  if (typeof b.displayText !== 'string' || !b.displayText) throw new Error('displayText is required');
  if (!Array.isArray(b.syllables) || b.syllables.length === 0 || !b.syllables.every((s) => typeof s === 'string')) {
    throw new Error('syllables must be a non-empty array of strings');
  }
  if (!Array.isArray(b.components) || !b.components.every((c) => typeof c === 'string')) {
    throw new Error('components must be an array of word_id strings');
  }
  return {
    wordId: b.wordId,
    displayText: b.displayText,
    syllables: b.syllables as string[],
    components: b.components as string[],
    // Optional: upstream has multi-word entries, so a phrase may have an etymology of its own. This
    // field used to be dropped silently here, which meant a curator adopting `ọmọ odù` lost its
    // entry_id with nothing reporting the loss. Absent still means the by-nature exemption.
    ...(b.citation === undefined ? {} : { citation: parseEntryIdCitation(b.citation) }),
    ...parsePublicationFields(b),
  };
}

export async function createPhraseFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireCurator(request);
    const input = parseCreatePhraseInput(await request.json());
    await createPhrase(getPool(), input, user.userId);
    return { status: 201, jsonBody: { wordId: input.wordId } };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordIdAlreadyExistsError) return { status: 409, jsonBody: { error: err.message } };
    // Same class of conflict as a duplicate word_id: something already holds this identity.
    if (err instanceof EntryAlreadyCitedError) return { status: 409, jsonBody: { error: err.message } };
    if (err instanceof NoComponentsError || err instanceof ComponentsNotFoundError) {
      return { status: 400, jsonBody: { error: err.message } };
    }
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('CreatePhrase', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'phrases',
  handler: createPhraseFunction,
});

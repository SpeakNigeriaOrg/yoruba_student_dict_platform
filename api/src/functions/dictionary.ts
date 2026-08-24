// functions/dictionary.ts
//
// The curator-level read surface:
//
//   GET /api/dictionary            - every word, with global state and what blocks it shipping
//   GET /api/dictionary/rights     - who has agreed to the terms, who has not been asked
//   GET /api/dictionary/coverage   - per-speaker playability, tone patterns, syllable stock
//   GET /api/words/{wordId}/dossier - everything held about one word
//   GET /api/images/{imageId}      - the bytes of one stored image
//
// Curator-only, server-side as well as in staticwebapp.config.json. These answer questions
// about the corpus rather than about the caller, which is the whole distinction from the
// per-user surfaces (assignments, axis-status): nothing here is scoped to who is asking.
//
// The survey returns the list AND its summary in one response rather than offering two
// endpoints. A count computed by a different query than the list it heads is a count that
// can disagree with it, and the overview's entire job is to be clicked through into that
// list.

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { getPool } from '../db.js';
import { ForbiddenError, requireCurator, UnauthenticatedError } from '../httpAuth.js';
import { loadDictionarySurvey, summariseDictionary } from '../handlers/dictionarySurvey.js';
import { loadWordDossier } from '../handlers/wordDossier.js';
import { loadRightsRoster } from '../handlers/rightsRoster.js';
import { loadCoverageReport } from '../handlers/coverageReport.js';
import { WordNotFoundError } from '../handlers/errors.js';

function errorResponse(err: unknown): HttpResponseInit {
  if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
  if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
  if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
  if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
  throw err;
}

export async function dictionarySurveyFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const words = await loadDictionarySurvey(getPool());
    return { status: 200, jsonBody: { words, overview: summariseDictionary(words) } };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('DictionarySurvey', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dictionary',
  handler: dictionarySurveyFunction,
});

export async function rightsRosterFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const roster = await loadRightsRoster(getPool(), CONTRIBUTOR_TERMS_VERSION);
    return { status: 200, jsonBody: roster };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('RightsRoster', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dictionary/rights',
  handler: rightsRosterFunction,
});

export async function coverageReportFunction(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    return { status: 200, jsonBody: await loadCoverageReport(getPool()) };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('CoverageReport', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dictionary/coverage',
  handler: coverageReportFunction,
});

export async function wordDossierFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const dossier = await loadWordDossier(getPool(), request.params.wordId);
    return { status: 200, jsonBody: dossier };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('WordDossier', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'words/{wordId}/dossier',
  handler: wordDossierFunction,
});

/** The first route in the app that serves an image.
 *
 * ~350 images have been generated and 0010 has stored them since, and no endpoint has ever
 * returned one - so "does this word have a picture" was answerable only by an offline
 * script, while being a hard gate on the game export. Bytes rather than base64 because an
 * image is an order of magnitude larger than the audio clips that are inlined, and an
 * <img src> wants a URL.
 *
 * Immutable caching: word_images rows are never updated in place (a new picture is a new
 * variant_number), so the bytes behind one image_id cannot change. */
export async function wordImageFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    await requireCurator(request);
    const { rows } = await getPool().query<{ image_data: Buffer; content_type: string }>(
      'select image_data, content_type from word_images where image_id = $1',
      [request.params.imageId],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: 'no such image' } };
    return {
      status: 200,
      headers: { 'Content-Type': rows[0].content_type, 'Cache-Control': 'private, max-age=31536000, immutable' },
      body: rows[0].image_data,
    };
  } catch (err) {
    return errorResponse(err);
  }
}

app.http('WordImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'images/{imageId}',
  handler: wordImageFunction,
});

// functions/utterances.ts
//
// POST /api/utterances/register - any authenticated user - takes the
// take's actual audio bytes (base64-encoded in the JSON body) and, for
// the segmented take, each per-syllable clip's bytes, and stores them
// directly in Postgres (see registerUtterance.ts's file header for the
// short-term "why bytea, not Blob Storage" rationale).

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { getPool } from '../db.js';
import { ForbiddenError, requireUser, UnauthenticatedError } from '../httpAuth.js';
import { registerUtterance, type RegisterSegmentInput, type RegisterUtteranceInput } from '../handlers/registerUtterance.js';
import { WordNotFoundError } from '../handlers/errors.js';

function parseAudioData(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required (base64-encoded audio bytes)`);
  return Buffer.from(value, 'base64');
}

function parseSegment(s: unknown): RegisterSegmentInput {
  if (!s || typeof s !== 'object') throw new Error('each segment must be an object');
  const seg = s as Record<string, unknown>;
  if (typeof seg.syllablePosition !== 'number') throw new Error('segment.syllablePosition must be a number');
  if (typeof seg.startTimeS !== 'number') throw new Error('segment.startTimeS must be a number');
  if (typeof seg.endTimeS !== 'number') throw new Error('segment.endTimeS must be a number');
  if (typeof seg.confidence !== 'number') throw new Error('segment.confidence must be a number');
  return {
    syllablePosition: seg.syllablePosition,
    startTimeS: seg.startTimeS,
    endTimeS: seg.endTimeS,
    confidence: seg.confidence,
    audioData: parseAudioData(seg.audioDataBase64, 'segment.audioDataBase64'),
  };
}

function parseRecordedSyllables(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((s) => typeof s === 'string' && s)) {
    throw new Error('recordedSyllables is required and must be a non-empty array of strings');
  }
  return value;
}

function parseRegisterInput(body: unknown): RegisterUtteranceInput {
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.wordId !== 'string' || !b.wordId) throw new Error('wordId is required');
  if (typeof b.takeNumber !== 'number') throw new Error('takeNumber is required');
  if (typeof b.recordedDisplayText !== 'string' || !b.recordedDisplayText) throw new Error('recordedDisplayText is required');
  if (b.segments !== undefined && !Array.isArray(b.segments)) throw new Error('segments must be an array if provided');
  return {
    wordId: b.wordId,
    takeNumber: b.takeNumber,
    audioData: parseAudioData(b.audioDataBase64, 'audioDataBase64'),
    recordedDisplayText: b.recordedDisplayText,
    recordedSyllables: parseRecordedSyllables(b.recordedSyllables),
    durationS: typeof b.durationS === 'number' ? b.durationS : undefined,
    sampleRate: typeof b.sampleRate === 'number' ? b.sampleRate : undefined,
    segments: Array.isArray(b.segments) ? b.segments.map(parseSegment) : undefined,
  };
}

export async function registerUtteranceFunction(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(request);
    const input = parseRegisterInput(await request.json());
    const result = await registerUtterance(getPool(), input, user.userId, user.username);
    return { status: 201, jsonBody: result };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { status: 401, jsonBody: { error: err.message } };
    if (err instanceof ForbiddenError) return { status: 403, jsonBody: { error: err.message } };
    if (err instanceof WordNotFoundError) return { status: 404, jsonBody: { error: err.message } };
    if (err instanceof Error) return { status: 400, jsonBody: { error: err.message } };
    throw err;
  }
}

app.http('RegisterUtterance', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'utterances/register',
  handler: registerUtteranceFunction,
});

// handlers/registerUtterance.ts
//
// Backs POST /utterances/register - called once per take, carrying that
// take's actual audio bytes (and, for the segmented take, each
// per-syllable clip's bytes) directly in the request body. Writes the
// real schema (db/migrations/0001_initial_schema.sql's
// utterances/syllable_observations tables, plus 0005's audio_data bytea
// columns) - re-registering the same (word_id, speaker_id, take_number)
// overwrites, matching this project's general "re-deciding overwrites"
// pattern (e.g. word_decisions).
//
// Short-term storage decision (see 0005_utterance_inline_audio.sql):
// audio lives in Postgres as bytea, not Azure Blob Storage - expected
// volume is small and this avoids paying for/operating a second storage
// service on top of the Postgres SSD already provisioned. blob_path is
// still populated (NOT NULL) with a deterministic, path-shaped logical
// identifier so a later move to real Blob Storage only needs to upload
// to that same path and null out audio_data - no consumer of blob_path
// has to change.
//
// Raw vs. processed (see 0008_raw_audio.sql): audio_data/blob_path are
// always "the current best version to play"; raw_audio_data/
// raw_blob_path are "exactly as captured/sliced, before any trimming or
// loudness normalization." No real processing step exists yet, so
// rawAudioData defaults to the same bytes as audioData when the caller
// doesn't supply a distinct one - raw is never null once a recording
// exists, and starts genuinely diverging only once real trim/normalize
// logic lands client-side, with no further schema change needed then.
//
// A speaker may record under a tentative pronunciation (spelling/tone)
// that golden_record later converges on something different from - so
// syllable_text is derived from the CLIENT-SUPPLIED recordedSyllables
// (what the speaker actually said), not golden_record.syllables (what
// the word currently, possibly later, resolves to). recordedSyllables
// is still an honest value, not free-text trusted for anything beyond
// this recording's own identity: it's stored verbatim alongside the
// audio precisely so review/playback later shows what pronunciation a
// given clip actually represents, distinct from the word's eventual
// canonical spelling.
//
// A divergence is REPORTED and never rejected. The recording says what the
// speaker said, which is the whole point of 0006 - but publish will drop it
// while it disagrees with golden_record, and the person who can act on that
// is the speaker, at the moment they finish recording. So the result carries
// matchesGolden and the screen says so. Refusing the write instead would
// destroy the belief the freeze exists to keep, and it would make the audio
// task unfinishable for a volunteer whose own spelling correction is still a
// pending contribution - which is exactly what the axis flag used to do.

import { orthographyInsensitiveForm, toneInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import type pg from 'pg';
import { recordingMatchesGolden } from '../reviewShared.js';
import { getOrCreateSpeakerForUser } from '../speakers.js';
import { WordNotFoundError } from './errors.js';
import { createHash } from 'node:crypto';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface RegisterSegmentInput {
  syllablePosition: number;
  startTimeS: number;
  endTimeS: number;
  confidence: number;
  audioData: Buffer;
  // Exactly as sliced, before any trimming/normalization - defaults to
  // audioData when omitted (see file header).
  rawAudioData?: Buffer;
  rawMediaType?: string;
  rawContainer?: 'wav' | 'webm' | 'ogg' | 'mp4';
}

export interface RegisterUtteranceInput {
  wordId: string;
  takeNumber: number;
  audioData: Buffer;
  // Exactly as captured, before any trimming/normalization - defaults to
  // audioData when omitted (see file header).
  rawAudioData?: Buffer;
  rawMediaType?: string;
  rawContainer?: 'wav' | 'webm' | 'ogg' | 'mp4';
  // The pronunciation actually spoken in this recording - independent of
  // (and may later diverge from) golden_record's current spelling/
  // syllabification. See file header.
  recordedDisplayText: string;
  recordedSyllables: string[];
  durationS?: number;
  sampleRate?: number;
  segments?: RegisterSegmentInput[];
}

export interface RegisterUtteranceResult {
  utteranceId: string;
  /** Whether this recording's own pronunciation still equals golden_record's current
   * display_text and syllables.
   *
   * False is ACCEPTED and stored - it is what the speaker said - but publish excludes it,
   * so the caller has to say so rather than reporting a bare success. */
  matchesGolden: boolean;
}

export async function registerUtterance(
  pool: pg.Pool,
  input: RegisterUtteranceInput,
  userId: string,
  speakerDisplayName: string,
): Promise<RegisterUtteranceResult> {
  return withTransaction(pool, (client) => registerUtteranceInTransaction(client, input, userId, speakerDisplayName));
}

async function registerUtteranceInTransaction(
  client: Queryable,
  input: RegisterUtteranceInput,
  userId: string,
  speakerDisplayName: string,
): Promise<RegisterUtteranceResult> {
  // Widened from `select 1`: the existence check and the publish comparison want the same
  // row, and reading it twice is how the two drift.
  const wordResult = await client.query<{ display_text: string; syllables: string[] }>(
    'select display_text, syllables from golden_record where word_id = $1',
    [input.wordId],
  );
  if (wordResult.rowCount === 0) throw new WordNotFoundError(input.wordId);
  const matchesGolden = recordingMatchesGolden(input.recordedDisplayText, input.recordedSyllables, wordResult.rows[0]);

  const speakerId = await getOrCreateSpeakerForUser(client, userId, speakerDisplayName);
  const status = input.segments && input.segments.length > 0 ? 'segmented' : 'pending_processing';

  // Deterministic, path-shaped logical identifier (see file header) -
  // there's no real upload step to generate one from, so it's derived
  // from the same key the unique constraint already uses.
  const blobPath = `utterances/${input.wordId}/${speakerId}/take${input.takeNumber}.wav`;
  const rawExtension = input.rawContainer === 'mp4' ? 'm4a' : (input.rawContainer ?? 'wav');
  const rawBlobPath = `utterances/${input.wordId}/${speakerId}/take${input.takeNumber}-raw.${rawExtension}`;
  const rawAudioData = input.rawAudioData ?? input.audioData;

  const utteranceResult = await client.query<{ utterance_id: string }>(
    `insert into utterances
       (word_id, speaker_id, take_number, submitted_by, blob_path, raw_blob_path, duration_s, sample_rate, status,
        audio_data, raw_audio_data, raw_media_type, raw_container, raw_sha256, delivery_media_type,
        recorded_display_text, recorded_syllables)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'audio/wav', $15, $16)
     on conflict (word_id, speaker_id, take_number) do update set
       submitted_by = excluded.submitted_by, blob_path = excluded.blob_path, raw_blob_path = excluded.raw_blob_path,
       duration_s = excluded.duration_s, sample_rate = excluded.sample_rate,
       status = excluded.status, audio_data = excluded.audio_data, raw_audio_data = excluded.raw_audio_data,
       raw_media_type = excluded.raw_media_type, raw_container = excluded.raw_container,
       raw_sha256 = excluded.raw_sha256,
       delivery_media_type = excluded.delivery_media_type,
       recorded_display_text = excluded.recorded_display_text, recorded_syllables = excluded.recorded_syllables,
       recorded_at = now()
     returning utterance_id`,
    [
      input.wordId,
      speakerId,
      input.takeNumber,
      userId,
      blobPath,
      rawBlobPath,
      input.durationS ?? null,
      input.sampleRate ?? null,
      status,
      input.audioData,
      rawAudioData,
      input.rawMediaType ?? null,
      input.rawContainer ?? null,
      rawAudioData ? sha256(rawAudioData) : null,
      input.recordedDisplayText,
      input.recordedSyllables,
    ],
  );
  const utteranceId = utteranceResult.rows[0].utterance_id;

  // Re-registering the same take replaces its segments wholesale rather
  // than trying to reconcile - a re-recorded/re-segmented take has no
  // meaningful correspondence between its old and new segment rows.
  await client.query('delete from syllable_observations where utterance_id = $1', [utteranceId]);

  for (const segment of input.segments ?? []) {
    const syllableText = input.recordedSyllables[segment.syllablePosition];
    if (syllableText === undefined) {
      throw new Error(
        `segment syllablePosition ${segment.syllablePosition} is out of range for the ${input.recordedSyllables.length} recorded syllables`,
      );
    }
    const segmentBlobPath = `utterances/${input.wordId}/${speakerId}/take${input.takeNumber}/syllable${segment.syllablePosition}.wav`;
    const segmentRawExtension = segment.rawContainer === 'mp4' ? 'm4a' : (segment.rawContainer ?? 'wav');
    const segmentRawBlobPath = `utterances/${input.wordId}/${speakerId}/take${input.takeNumber}/syllable${segment.syllablePosition}-raw.${segmentRawExtension}`;
    const segmentRawAudioData = segment.rawAudioData ?? segment.audioData;
    await client.query(
      `insert into syllable_observations
         (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive,
          legacy_syllable_key, start_time_s, end_time_s, vad_confidence, blob_path, audio_data, raw_blob_path, raw_audio_data,
          raw_media_type, raw_container, raw_sha256, delivery_media_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'audio/wav')`,
      [
        utteranceId,
        segment.syllablePosition,
        syllableText,
        toneInsensitiveForm(syllableText),
        orthographyInsensitiveForm(syllableText),
        // Not the real legacy generate_syllable_info scheme (safe-name +
        // tone-suffix) - that Python logic hasn't been ported to shared/.
        // This is an honest placeholder (orthography-insensitive form
        // only), fine for this feature's own use, but NOT yet correct for
        // the separate R2 legacy-game publish step, which is out of scope
        // here and would need the real scheme ported first.
        orthographyInsensitiveForm(syllableText),
        segment.startTimeS,
        segment.endTimeS,
        segment.confidence,
        segmentBlobPath,
        segment.audioData,
        segmentRawBlobPath,
        segmentRawAudioData,
        segment.rawMediaType ?? null,
        segment.rawContainer ?? null,
        sha256(segmentRawAudioData),
      ],
    );
  }

  return { utteranceId, matchesGolden };
}

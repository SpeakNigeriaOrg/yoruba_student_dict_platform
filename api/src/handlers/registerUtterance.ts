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

import { orthographyInsensitiveForm, toneInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import type pg from 'pg';
import { getOrCreateSpeakerForUser } from '../speakers.js';
import { WordNotFoundError } from './errors.js';

export interface RegisterSegmentInput {
  syllablePosition: number;
  startTimeS: number;
  endTimeS: number;
  confidence: number;
  audioData: Buffer;
}

export interface RegisterUtteranceInput {
  wordId: string;
  takeNumber: number;
  audioData: Buffer;
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
}

export async function registerUtterance(
  pool: pg.Pool,
  input: RegisterUtteranceInput,
  userId: string,
  username: string,
): Promise<RegisterUtteranceResult> {
  return withTransaction(pool, (client) => registerUtteranceInTransaction(client, input, userId, username));
}

async function registerUtteranceInTransaction(
  client: Queryable,
  input: RegisterUtteranceInput,
  userId: string,
  username: string,
): Promise<RegisterUtteranceResult> {
  const wordResult = await client.query('select 1 from golden_record where word_id = $1', [input.wordId]);
  if (wordResult.rowCount === 0) throw new WordNotFoundError(input.wordId);

  const speakerId = await getOrCreateSpeakerForUser(client, userId, username);
  const status = input.segments && input.segments.length > 0 ? 'segmented' : 'pending_processing';

  // Deterministic, path-shaped logical identifier (see file header) -
  // there's no real upload step to generate one from, so it's derived
  // from the same key the unique constraint already uses.
  const blobPath = `utterances/${input.wordId}/${speakerId}/take${input.takeNumber}.wav`;

  const utteranceResult = await client.query<{ utterance_id: string }>(
    `insert into utterances
       (word_id, speaker_id, take_number, submitted_by, blob_path, duration_s, sample_rate, status, audio_data,
        recorded_display_text, recorded_syllables)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (word_id, speaker_id, take_number) do update set
       submitted_by = excluded.submitted_by, blob_path = excluded.blob_path,
       duration_s = excluded.duration_s, sample_rate = excluded.sample_rate,
       status = excluded.status, audio_data = excluded.audio_data,
       recorded_display_text = excluded.recorded_display_text, recorded_syllables = excluded.recorded_syllables,
       recorded_at = now()
     returning utterance_id`,
    [
      input.wordId,
      speakerId,
      input.takeNumber,
      userId,
      blobPath,
      input.durationS ?? null,
      input.sampleRate ?? null,
      status,
      input.audioData,
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
    await client.query(
      `insert into syllable_observations
         (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive,
          legacy_syllable_key, start_time_s, end_time_s, vad_confidence, blob_path, audio_data)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      ],
    );
  }

  return { utteranceId };
}

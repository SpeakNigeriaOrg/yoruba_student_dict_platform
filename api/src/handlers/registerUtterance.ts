// handlers/registerUtterance.ts
//
// Backs POST /utterances/register - called once per take, after that
// take's blob (and, for the segmented take, each per-syllable clip) has
// already been uploaded directly to Blob Storage using the SAS token
// issueUploadSasToken.ts issued. Writes the real schema
// (db/migrations/0001_initial_schema.sql's utterances/syllable_observations
// tables) - re-registering the same (word_id, speaker_id, take_number)
// overwrites, matching this project's general "re-deciding overwrites"
// pattern (e.g. word_decisions).
//
// syllable_text is derived server-side from golden_record.syllables[position]
// (never trusted from the client) - the recording only carries audio, the
// actual Yoruba text for each position is this word's own already-known
// syllable list, same "check again server-side" principle used throughout
// this project.

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
  blobPath: string;
}

export interface RegisterUtteranceInput {
  wordId: string;
  takeNumber: number;
  blobPath: string;
  rawBlobPath?: string;
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
  const wordResult = await client.query<{ syllables: string[] }>('select syllables from golden_record where word_id = $1', [
    input.wordId,
  ]);
  const wordRow = wordResult.rows[0];
  if (!wordRow) throw new WordNotFoundError(input.wordId);

  const speakerId = await getOrCreateSpeakerForUser(client, userId, username);
  const status = input.segments && input.segments.length > 0 ? 'segmented' : 'pending_processing';

  const utteranceResult = await client.query<{ utterance_id: string }>(
    `insert into utterances (word_id, speaker_id, take_number, submitted_by, blob_path, raw_blob_path, duration_s, sample_rate, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (word_id, speaker_id, take_number) do update set
       submitted_by = excluded.submitted_by, blob_path = excluded.blob_path,
       raw_blob_path = excluded.raw_blob_path, duration_s = excluded.duration_s,
       sample_rate = excluded.sample_rate, status = excluded.status, recorded_at = now()
     returning utterance_id`,
    [
      input.wordId,
      speakerId,
      input.takeNumber,
      userId,
      input.blobPath,
      input.rawBlobPath ?? null,
      input.durationS ?? null,
      input.sampleRate ?? null,
      status,
    ],
  );
  const utteranceId = utteranceResult.rows[0].utterance_id;

  // Re-registering the same take replaces its segments wholesale rather
  // than trying to reconcile - a re-recorded/re-segmented take has no
  // meaningful correspondence between its old and new segment rows.
  await client.query('delete from syllable_observations where utterance_id = $1', [utteranceId]);

  for (const segment of input.segments ?? []) {
    const syllableText = wordRow.syllables[segment.syllablePosition];
    if (syllableText === undefined) {
      throw new Error(
        `segment syllablePosition ${segment.syllablePosition} is out of range for word '${input.wordId}' (${wordRow.syllables.length} syllables)`,
      );
    }
    await client.query(
      `insert into syllable_observations
         (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive,
          legacy_syllable_key, start_time_s, end_time_s, vad_confidence, blob_path)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        segment.blobPath,
      ],
    );
  }

  return { utteranceId };
}

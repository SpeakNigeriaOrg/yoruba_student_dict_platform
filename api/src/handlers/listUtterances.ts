// handlers/listUtterances.ts
//
// Backs GET /words/{wordId}/utterances - read-only playback of every
// recording registered for a word, across every speaker. Recordings
// aren't login-scoped (a speaker isn't necessarily a platform user at
// all - see migrateLegacyAudio.mjs, which registers recordings under a
// speaker with no user_id), so there's no notion of "viewing as" a
// speaker: any authenticated user can already listen to any speaker's
// recordings for a word, same permission tier as the other review-axis
// GET endpoints.
//
// Audio bytes are included inline (base64), same short-term storage
// choice as registerUtterance.ts - clips are short, so this stays small.

import type { Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';

export interface UtteranceSegmentSummary {
  syllablePosition: number;
  syllableText: string;
  startTimeS: number;
  endTimeS: number;
  vadConfidence: number | null;
  audioDataBase64: string;
  // Exactly as sliced, before any trimming/normalization - see
  // registerUtterance.ts's file header. Equal to audioDataBase64 until a
  // real processing step exists.
  rawAudioDataBase64: string;
}

export interface UtteranceSummary {
  utteranceId: string;
  speakerId: string;
  speakerDisplayName: string;
  takeNumber: number;
  status: string;
  recordedDisplayText: string;
  recordedSyllables: string[];
  durationS: number | null;
  sampleRate: number | null;
  recordedAt: string;
  audioDataBase64: string | null;
  rawAudioDataBase64: string | null;
  segments: UtteranceSegmentSummary[];
}

export async function listUtterances(client: Queryable, wordId: string): Promise<UtteranceSummary[]> {
  const wordResult = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if (wordResult.rowCount === 0) throw new WordNotFoundError(wordId);

  const utteranceRows = await client.query<{
    utterance_id: string;
    speaker_id: string;
    speaker_display_name: string;
    take_number: number;
    status: string;
    recorded_display_text: string;
    recorded_syllables: string[];
    duration_s: string | null;
    sample_rate: number | null;
    recorded_at: string;
    audio_data: Buffer | null;
    raw_audio_data: Buffer | null;
  }>(
    `select u.utterance_id, u.speaker_id, s.display_name as speaker_display_name, u.take_number, u.status,
            u.recorded_display_text, u.recorded_syllables, u.duration_s, u.sample_rate, u.recorded_at,
            u.audio_data, u.raw_audio_data
     from utterances u
     join speakers s on s.speaker_id = u.speaker_id
     where u.word_id = $1
     order by s.display_name, u.take_number`,
    [wordId],
  );

  const segmentRows = await client.query<{
    utterance_id: string;
    syllable_position: number;
    syllable_text: string;
    start_time_s: string;
    end_time_s: string;
    vad_confidence: string | null;
    audio_data: Buffer;
    raw_audio_data: Buffer;
  }>(
    `select utterance_id, syllable_position, syllable_text, start_time_s, end_time_s, vad_confidence,
            audio_data, raw_audio_data
     from syllable_observations
     where utterance_id = any($1)
     order by utterance_id, syllable_position`,
    [utteranceRows.rows.map((r) => r.utterance_id)],
  );
  const segmentsByUtterance = new Map<string, UtteranceSegmentSummary[]>();
  for (const row of segmentRows.rows) {
    const list = segmentsByUtterance.get(row.utterance_id) ?? [];
    list.push({
      syllablePosition: row.syllable_position,
      syllableText: row.syllable_text,
      startTimeS: Number(row.start_time_s),
      endTimeS: Number(row.end_time_s),
      vadConfidence: row.vad_confidence === null ? null : Number(row.vad_confidence),
      audioDataBase64: row.audio_data.toString('base64'),
      rawAudioDataBase64: row.raw_audio_data.toString('base64'),
    });
    segmentsByUtterance.set(row.utterance_id, list);
  }

  return utteranceRows.rows.map((row) => ({
    utteranceId: row.utterance_id,
    speakerId: row.speaker_id,
    speakerDisplayName: row.speaker_display_name,
    takeNumber: row.take_number,
    status: row.status,
    recordedDisplayText: row.recorded_display_text,
    recordedSyllables: row.recorded_syllables,
    durationS: row.duration_s === null ? null : Number(row.duration_s),
    sampleRate: row.sample_rate,
    recordedAt: row.recorded_at,
    audioDataBase64: row.audio_data === null ? null : row.audio_data.toString('base64'),
    rawAudioDataBase64: row.raw_audio_data === null ? null : row.raw_audio_data.toString('base64'),
    segments: segmentsByUtterance.get(row.utterance_id) ?? [],
  }));
}

// handlers/listSyllableObservations.ts
//
// Backs GET /syllables/{syllableText}/observations - every recording of
// one exact, tone-specific syllable, decoupled from which word it came
// from. This is the query `syllable_observations_enriched`
// (db/migrations/0001_initial_schema.sql) was purpose-built for: tone is
// the whole point of a syllable pronunciation library (two recordings of
// "the same syllable" at different tones are not interchangeable), so
// lookup is keyed on syllable_text - the exact, diacritic-intact form -
// not the tone-insensitive/orthography-insensitive variants, which exist
// for broader matching elsewhere, not as a substitute identity here.
//
// Each result still carries its origin (word, speaker, take, position -
// position matters because a syllable can repeat within one word, e.g.
// "kò" appears twice in "ìkòkò", each occurrence its own row/recording),
// via the same word_id/speaker_id/take_number the view joins in from
// utterances - decoupled for lookup, not for provenance.

import type { Queryable } from '../db.js';

export interface SyllableObservationSummary {
  observationId: string;
  wordId: string;
  speakerId: string;
  speakerDisplayName: string;
  takeNumber: number;
  syllablePosition: number;
  startTimeS: number;
  endTimeS: number;
  vadConfidence: number | null;
  audioDataBase64: string;
}

export async function listSyllableObservations(client: Queryable, syllableText: string): Promise<SyllableObservationSummary[]> {
  const rows = await client.query<{
    observation_id: string;
    word_id: string;
    speaker_id: string;
    speaker_display_name: string;
    take_number: number;
    syllable_position: number;
    start_time_s: string;
    end_time_s: string;
    vad_confidence: string | null;
    audio_data: Buffer;
  }>(
    `select e.observation_id, e.word_id, e.speaker_id, s.display_name as speaker_display_name, e.take_number,
            e.syllable_position, e.start_time_s, e.end_time_s, e.vad_confidence, e.audio_data
     from syllable_observations_enriched e
     join speakers s on s.speaker_id = e.speaker_id
     where e.syllable_text = $1
     order by e.word_id, s.display_name, e.take_number, e.syllable_position`,
    [syllableText],
  );

  return rows.rows.map((row) => ({
    observationId: row.observation_id,
    wordId: row.word_id,
    speakerId: row.speaker_id,
    speakerDisplayName: row.speaker_display_name,
    takeNumber: row.take_number,
    syllablePosition: row.syllable_position,
    startTimeS: Number(row.start_time_s),
    endTimeS: Number(row.end_time_s),
    vadConfidence: row.vad_confidence === null ? null : Number(row.vad_confidence),
    audioDataBase64: row.audio_data.toString('base64'),
  }));
}

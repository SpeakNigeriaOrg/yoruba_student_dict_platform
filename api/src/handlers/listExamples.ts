// handlers/listExamples.ts
//
// Backs GET /words/{wordId}/examples - every live example of a word in use, with audio
// inline as base64 (same short-term storage choice as listUtterances.ts).
//
// Excluded examples are omitted, not deleted: 0015 keeps the row so what someone said
// survives a curator removing it from the collection, exactly as 0013 does for
// contributions. Nothing in this schema destroys a contribution.

import type { Queryable } from '../db.js';
import type { ExampleType } from './submitExample.js';

export interface ExampleSummary {
  exampleId: string;
  exampleType: ExampleType;
  exampleText: string;
  translation: string;
  audioDataBase64: string;
  submittedAt: string;
  contributorLabel: string;
  /** Whether this is the requesting user's own, so the UI can separate "yours" from
   * "other people's" rather than blending them - the same distinction listUtterances
   * makes for recordings. */
  isOwn: boolean;
  /** The word's spelling when this example was contributed, and whether it still matches.
   *
   * An example illustrates a word as it was spelled then. Phase F made tone corrections
   * routine, so this surfaces the case where the word has since moved - the example may
   * still be perfectly good, but a curator should be the one to decide that rather than
   * discovering it silently. */
  recordedWordText: string;
  wordTextChanged: boolean;
}

export async function listExamples(client: Queryable, wordId: string, userId: string): Promise<ExampleSummary[]> {
  const { rows } = await client.query<{
    example_id: string;
    example_type: ExampleType;
    example_text: string;
    translation: string;
    audio_base64: string;
    submitted_at: Date;
    contributor_label: string | null;
    is_own: boolean;
    recorded_word_text: string;
    word_text_changed: boolean;
  }>(
    `select e.example_id,
            e.example_type,
            e.example_text,
            e.translation,
            encode(e.audio_data, 'base64') as audio_base64,
            e.submitted_at,
            coalesce(u.display_name, u.email) as contributor_label,
            (e.submitted_by = $2) as is_own,
            e.recorded_word_text,
            (e.recorded_word_text <> g.display_text) as word_text_changed
     from word_examples e
     join golden_record g on g.word_id = e.word_id
     left join users u on u.user_id = e.submitted_by
     where e.word_id = $1 and e.excluded_at is null
     order by e.submitted_at`,
    [wordId, userId],
  );

  return rows.map((r) => ({
    exampleId: r.example_id,
    exampleType: r.example_type,
    exampleText: r.example_text,
    translation: r.translation,
    audioDataBase64: r.audio_base64,
    submittedAt: r.submitted_at.toISOString(),
    contributorLabel: r.contributor_label ?? 'unknown',
    isOwn: r.is_own,
    recordedWordText: r.recorded_word_text,
    wordTextChanged: r.word_text_changed,
  }));
}

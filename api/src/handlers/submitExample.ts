// handlers/submitExample.ts
//
// Backs POST /words/{wordId}/examples - one contributor's example of a word in use: the
// phrase, its English translation, and audio at natural pace.
//
// ---------------------------------------------------------------------------
// Why this is not a contribution and not a decision
// ---------------------------------------------------------------------------
// Every other content axis records a claim about one truth, so two contributors either
// agree or conflict, and consensus.ts tallies them. This axis does not work that way: two
// volunteers offering different examples for `adìyẹ` have produced MORE MATERIAL, not a
// disagreement to resolve. So there is no fingerprint, no tally and no curator
// adjudication - the model is the audio axis, where everyone contributes their own and all
// of it is kept.
//
// One per person per word, enforced by the unique key rather than by checking first: a
// second submission from the same person replaces their own and cannot touch anyone
// else's.

import type { Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';

export type ExampleType = 'derived_term' | 'derived_phrase' | 'usage_phrase';

export const EXAMPLE_TYPES: readonly ExampleType[] = ['derived_term', 'derived_phrase', 'usage_phrase'];

export interface SubmitExampleInput {
  exampleType: ExampleType;
  /** The phrase with diacritics intact, exactly as the composer produced it. */
  exampleText: string;
  translation: string;
  /** WAV bytes, base64. Inline for the same reason utterances are (0005): there is no
   * Storage account yet, and a phrase at natural pace is a second or two. */
  audioBase64: string;
}

export interface SubmittedExample {
  exampleId: string;
}

export class ExampleIncompleteError extends Error {
  constructor(missing: 'exampleText' | 'translation' | 'audio') {
    super(
      missing === 'audio'
        ? 'an example needs a recording - the point of it is hearing the word used, not reading it'
        : `${missing} is required: an example is the phrase, its meaning and its audio, submitted together`,
    );
    this.name = 'ExampleIncompleteError';
  }
}

export class InvalidExampleTypeError extends Error {
  constructor(given: string) {
    super(`exampleType must be one of ${EXAMPLE_TYPES.join(', ')} - got '${given}'`);
    this.name = 'InvalidExampleTypeError';
  }
}

export async function submitExample(
  client: Queryable,
  wordId: string,
  input: SubmitExampleInput,
  submittedBy: string,
): Promise<SubmittedExample> {
  if (!EXAMPLE_TYPES.includes(input.exampleType)) throw new InvalidExampleTypeError(String(input.exampleType));
  if (!input.exampleText?.trim()) throw new ExampleIncompleteError('exampleText');
  if (!input.translation?.trim()) throw new ExampleIncompleteError('translation');
  if (!input.audioBase64) throw new ExampleIncompleteError('audio');

  // recorded_word_text is read from golden_record IN THE SAME STATEMENT as the insert, so
  // it cannot be a copy of a spelling that changed between two round trips - and the
  // insert fails cleanly if the word does not exist, rather than storing an orphan.
  //
  // Freezing it at all follows the discipline 0006 set for recordings and 0014 for citation
  // pins: this example illustrates the word AS IT WAS SPELLED THEN. Phase F made tone
  // corrections routine, so a later respelling must not silently reinterpret what someone
  // chose to illustrate.
  const result = await client.query<{ example_id: string }>(
    `insert into word_examples
       (word_id, submitted_by, example_type, example_text, translation, audio_data, recorded_word_text)
     select g.word_id, $2, $3, $4, $5, decode($6, 'base64'), g.display_text
     from golden_record g where g.word_id = $1
     on conflict (word_id, submitted_by) do update set
       example_type       = excluded.example_type,
       example_text       = excluded.example_text,
       translation        = excluded.translation,
       audio_data         = excluded.audio_data,
       recorded_word_text = excluded.recorded_word_text,
       submitted_at       = now(),
       -- Replacing your own example clears any prior exclusion: it is a new
       -- contribution, and carrying the old verdict over would silently suppress it.
       excluded_by        = null,
       excluded_at        = null,
       excluded_reason    = null
     returning example_id`,
    [wordId, submittedBy, input.exampleType, input.exampleText.trim(), input.translation.trim(), input.audioBase64],
  );

  if (result.rows.length === 0) throw new WordNotFoundError(wordId);
  return { exampleId: result.rows[0].example_id };
}

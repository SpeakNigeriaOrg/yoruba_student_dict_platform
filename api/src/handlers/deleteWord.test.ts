import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { WordNotFoundError } from './errors.js';
import {
  deleteWord,
  previewWordDeletion,
  WordHasAttachedWorkError,
  WordIsAComponentError,
} from './deleteWord.js';

const NS = 'testdelw_';
const pool = getTestPool();
let userId: string;
let speakerId: string;

async function cleanUpSpeakers(): Promise<void> {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
}

beforeAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  const user = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, 'Test Curator', 'curator') returning user_id",
    [`${NS}curator@example.com`],
  );
  userId = user.rows[0].user_id;
  const speaker = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name) values ($1) returning speaker_id',
    [`${NS}speaker`],
  );
  speakerId = speaker.rows[0].speaker_id;
});

afterAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

// Every word this file makes is named `${NS}w...`, so one namespaced clean-up between cases
// keeps them independent while leaving the shared curator and speaker rows in place.
beforeEach(async () => {
  await cleanUpTestData(pool, `${NS}w`);
});

async function insertWord(wordId: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    'ọwọ́',
    ['ọ', 'wọ́'],
  ]);
}

async function insertUtterance(wordId: string, take: number): Promise<string> {
  const { rows } = await pool.query<{ utterance_id: string }>(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
     values ($1, $2, $3, $4, 'ọwọ́', $5) returning utterance_id`,
    [wordId, speakerId, take, `utterances/${wordId}-${take}.wav`, ['ọ', 'wọ́']],
  );
  return rows[0].utterance_id;
}

async function insertSyllableObservation(utteranceId: string, position: number): Promise<void> {
  await pool.query(
    `insert into syllable_observations
       (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive,
        syllable_orthography_insensitive, legacy_syllable_key, start_time_s, end_time_s, blob_path)
     values ($1, $2, 'wọ́', 'wọ', 'wo', 'wo', 0.0, 0.4, $3)`,
    [utteranceId, position, `syllables/${utteranceId}-${position}.wav`],
  );
}

describe('previewWordDeletion', () => {
  it('refuses an unknown word rather than reporting an empty impact', async () => {
    await expect(previewWordDeletion(pool, `${NS}wnope`)).rejects.toThrow(WordNotFoundError);
  });

  it('reports nothing attached for a freshly added word', async () => {
    await insertWord(`${NS}wfresh`);
    const impact = await previewWordDeletion(pool, `${NS}wfresh`);
    expect(impact).toEqual({
      wordId: `${NS}wfresh`,
      displayText: 'ọwọ́',
      attached: [],
      attachedTotal: 0,
      usedAsComponentOf: [],
    });
  });

  it('counts recordings, the syllable clips cut from them, and every other attached row', async () => {
    const wordId = `${NS}wbusy`;
    await insertWord(wordId);
    const first = await insertUtterance(wordId, 1);
    await insertUtterance(wordId, 2);
    await insertSyllableObservation(first, 0);
    await insertSyllableObservation(first, 1);
    await pool.query(
      `insert into word_images (word_id, art_style, image_data, blob_path) values ($1, 'cartoon', $2, $3)`,
      [wordId, Buffer.from('png'), `images/cartoon/${wordId}.png`],
    );
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', $2, $3)`,
      [wordId, { definitionAction: 'confirm' }, userId],
    );
    await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [wordId, userId]);
    await pool.query(
      `insert into word_decisions_premerge (word_id, axis, decision, decided_by, decided_at)
       values ($1, 'spelling', $2, $3, now())`,
      [wordId, { action: 'keep_ours' }, userId],
    );

    const impact = await previewWordDeletion(pool, wordId);
    expect(Object.fromEntries(impact.attached.map((a) => [a.label, a.count]))).toEqual({
      'audio recordings': 2,
      'syllable clips cut from those recordings': 2,
      images: 1,
      'review decisions': 1,
      'review assignments': 1,
      'archived pre-merge decisions': 1,
    });
    expect(impact.attachedTotal).toBe(8);
  });

  it('names the entries built from this word, which are a blocker rather than a casualty', async () => {
    await insertWord(`${NS}wpart`);
    await insertWord(`${NS}wowner`);
    await pool.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)',
      [`${NS}wowner`, `${NS}wpart`],
    );

    const impact = await previewWordDeletion(pool, `${NS}wpart`);
    expect(impact.usedAsComponentOf).toEqual([`${NS}wowner`]);
    // The link belongs to the OWNER, so it must not also be counted as something this word
    // loses - a curator reading "1 component link" would think confirming were enough.
    expect(impact.attached).toEqual([]);
  });
});

describe('deleteWord', () => {
  it('deletes a word with nothing attached without asking for a confirm', async () => {
    await insertWord(`${NS}wsolo`);
    const impact = await deleteWord(pool, `${NS}wsolo`);
    expect(impact.attachedTotal).toBe(0);
    const remaining = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}wsolo`]);
    expect(remaining.rowCount).toBe(0);
  });

  it('refuses without a confirm once anything is attached, and changes nothing', async () => {
    const wordId = `${NS}wguard`;
    await insertWord(wordId);
    await insertUtterance(wordId, 1);

    await expect(deleteWord(pool, wordId)).rejects.toThrow(WordHasAttachedWorkError);
    const word = await pool.query('select 1 from golden_record where word_id = $1', [wordId]);
    const utterances = await pool.query('select 1 from utterances where word_id = $1', [wordId]);
    expect(word.rowCount).toBe(1);
    expect(utterances.rowCount).toBe(1);
  });

  it('carries the impact on the refusal, so a caller that skipped the preview still has it', async () => {
    const wordId = `${NS}wguard2`;
    await insertWord(wordId);
    await insertUtterance(wordId, 1);

    await expect(deleteWord(pool, wordId)).rejects.toMatchObject({
      impact: { attached: [{ label: 'audio recordings', count: 1 }] },
    });
  });

  it('with a confirm, removes the word and everything that cascades from it', async () => {
    const wordId = `${NS}wgone`;
    await insertWord(wordId);
    const utteranceId = await insertUtterance(wordId, 1);
    await insertSyllableObservation(utteranceId, 0);
    await pool.query(
      `insert into word_examples (word_id, submitted_by, example_type, example_text, translation, audio_data, recorded_word_text)
       values ($1, $2, 'usage_phrase', 'mo ní ọwọ́', 'I have a hand', $3, 'ọwọ́')`,
      [wordId, userId, Buffer.from('wav')],
    );
    await pool.query(
      `insert into upstream_citations (word_id, exempt_reason, pin) values ($1, 'test word', '{}'::jsonb)`,
      [wordId],
    );
    await pool.query(
      `insert into word_decisions_premerge (word_id, axis, decision, decided_by, decided_at)
       values ($1, 'spelling', '{}'::jsonb, $2, now())`,
      [wordId, userId],
    );
    // The two canonical-pick tables, which are the awkward corner of the cascade:
    // canonical_image_selections.image_id references word_images(image_id) with no cascade of
    // its own, so both rows have to go in the same cascade without the referential check
    // firing in between.
    await pool.query(
      `insert into word_images (word_id, art_style, image_data, blob_path) values ($1, 'cartoon', $2, 'i.png')`,
      [wordId, Buffer.from('png')],
    );
    await pool.query(
      `insert into canonical_image_selections (word_id, art_style, image_id, selected_by)
       select $1, 'cartoon', image_id, $2 from word_images where word_id = $1`,
      [wordId, userId],
    );
    await pool.query(
      `insert into canonical_utterance_selections (word_id, speaker_id, utterance_id, selected_by)
       values ($1, $2, $3, $4)`,
      [wordId, speakerId, utteranceId, userId],
    );

    const impact = await deleteWord(pool, wordId, { confirm: true });
    expect(impact.attachedTotal).toBeGreaterThan(0);

    for (const [table, column] of [
      ['golden_record', 'word_id'],
      ['utterances', 'word_id'],
      ['word_examples', 'word_id'],
      ['upstream_citations', 'word_id'],
      ['word_decisions_premerge', 'word_id'],
      ['word_images', 'word_id'],
      ['canonical_image_selections', 'word_id'],
      ['canonical_utterance_selections', 'word_id'],
    ] as const) {
      const { rowCount } = await pool.query(`select 1 from ${table} where ${column} = $1`, [wordId]);
      expect(`${table}: ${rowCount}`).toBe(`${table}: 0`);
    }
    // Cascaded through utterances, not directly - the clips are the reason the count above
    // reports them at all.
    const clips = await pool.query('select 1 from syllable_observations where utterance_id = $1', [utteranceId]);
    expect(clips.rowCount).toBe(0);
  });

  it('refuses a word other entries are built from, confirm or not', async () => {
    await insertWord(`${NS}wpart2`);
    await insertWord(`${NS}wowner2`);
    await pool.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)',
      [`${NS}wowner2`, `${NS}wpart2`],
    );

    await expect(deleteWord(pool, `${NS}wpart2`, { confirm: true })).rejects.toThrow(WordIsAComponentError);
    const still = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}wpart2`]);
    expect(still.rowCount).toBe(1);
  });

  it("deletes an owner word and its own component links, which are not a blocker", async () => {
    await insertWord(`${NS}wpart3`);
    await insertWord(`${NS}wowner3`);
    await pool.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)',
      [`${NS}wowner3`, `${NS}wpart3`],
    );

    await deleteWord(pool, `${NS}wowner3`, { confirm: true });
    const part = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}wpart3`]);
    expect(part.rowCount).toBe(1);
  });
});

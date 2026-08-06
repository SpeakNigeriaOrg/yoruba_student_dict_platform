import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getAxisStatus } from './getAxisStatus.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testaxisstat_';
const pool = getTestPool();
let userId: string;

beforeAll(async () => {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}requester`, 'Test Requester'],
  );
  userId = result.rows[0].user_id;
});

afterAll(async () => {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    wordId,
    [wordId],
  ]);
}

describe('getAxisStatus', () => {
  it('reports every axis as not-decided/no-audio for a brand-new word', async () => {
    const wordId = `${NS}word_one`;
    await insertWord(wordId);

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result).toEqual({ entry: false, etymology: false, audio: false, example: false });
  });

  it('reports spelling as decided once a word_decisions row exists', async () => {
    const wordId = `${NS}word_two`;
    await insertWord(wordId);
    const user = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}decider`, 'Test Decider'],
    );
    await pool.query("insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', '{}', $2)", [
      wordId,
      user.rows[0].user_id,
    ]);

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result).toEqual({ entry: true, etymology: false, audio: false, example: false });
  });

  it('reports audio as recorded once the REQUESTING user has their own utterance registered', async () => {
    const wordId = `${NS}word_three`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}speaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(true);
  });

  it("does NOT report audio as recorded when only a DIFFERENT user's speaker recorded it - every participant must record every word themselves", async () => {
    const wordId = `${NS}word_four`;
    await insertWord(wordId);
    const otherUser = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
      [`${NS}otheruser`, 'Other User'],
    );
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}otherspeaker`, otherUser.rows[0].user_id],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(false);
  });

  it('stops reporting audio once the word is re-split, because publish stops accepting it', async () => {
    // The gap this closes: the axis used to ask only "does this user have a row in utterances?", so
    // a word whose spelling or split changed after recording read as DONE while every one of its
    // recordings was being silently dropped from the game export. The axis that should have raised
    // it was the one saying green.
    const wordId = `${NS}word_resplit`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}resplitspeaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );
    expect((await getAxisStatus(pool, wordId, userId)).audio).toBe(true);

    // Re-split the word without touching the recording - exactly what freeing a nasal does.
    await pool.query('update golden_record set syllables = $1 where word_id = $2', [[wordId, 'n̄'], wordId]);

    expect((await getAxisStatus(pool, wordId, userId)).audio).toBe(false);
  });

  it('stops reporting audio once the word is re-spelled', async () => {
    const wordId = `${NS}word_respelled`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}respellspeaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    await pool.query('update golden_record set display_text = $1 where word_id = $2', [`${wordId}x`, wordId]);

    expect((await getAxisStatus(pool, wordId, userId)).audio).toBe(false);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(getAxisStatus(pool, `${NS}nonexistent`, userId)).rejects.toThrow(WordNotFoundError);
  });
});

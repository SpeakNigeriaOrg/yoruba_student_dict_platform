import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getAxisStatus } from './getAxisStatus.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testaxisstat_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
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

    const result = await getAxisStatus(pool, wordId);
    expect(result).toEqual({ spelling: false, definition: false, etymology: false, audio: false });
  });

  it('reports spelling as decided once a word_decisions row exists', async () => {
    const wordId = `${NS}word_two`;
    await insertWord(wordId);
    const user = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}decider`, 'Test Decider'],
    );
    await pool.query("insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'spelling', '{}', $2)", [
      wordId,
      user.rows[0].user_id,
    ]);

    const result = await getAxisStatus(pool, wordId);
    expect(result).toEqual({ spelling: true, definition: false, etymology: false, audio: false });
  });

  it('reports audio as recorded once at least one utterance is registered', async () => {
    const wordId = `${NS}word_three`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      "insert into speakers (display_name) values ($1) returning speaker_id",
      [`${NS}speaker`],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    const result = await getAxisStatus(pool, wordId);
    expect(result.audio).toBe(true);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(getAxisStatus(pool, `${NS}nonexistent`)).rejects.toThrow(WordNotFoundError);
  });
});

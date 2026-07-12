import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listAllWords } from './listAllWords.js';

const NS = 'testlistall_';
const pool = getTestPool();
let userId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}requester`, 'Test Requester'],
  );
  userId = result.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('listAllWords', () => {
  it('lists real seeded words with their per-axis decided status', async () => {
    const decidedWordId = `${NS}decided_word`;
    const undecidedWordId = `${NS}undecided_word`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      decidedWordId, `${NS}decidedspelling`, [`${NS}decidedspelling`],
    ]);
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      undecidedWordId, `${NS}undecidedspelling`, [`${NS}undecidedspelling`],
    ]);
    const curatorResult = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}curator`, 'Test Curator'],
    );
    await pool.query(`insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'definition', $2, $3)`, [
      decidedWordId,
      JSON.stringify({ definitionAction: 'confirm' }),
      curatorResult.rows[0].user_id,
    ]);

    const words = await listAllWords(pool, userId);
    const decided = words.find((w) => w.wordId === decidedWordId);
    const undecided = words.find((w) => w.wordId === undecidedWordId);

    expect(decided?.axisDecided).toEqual({ spelling: false, definition: true, etymology: false, audio: false });
    expect(undecided?.axisDecided).toEqual({ spelling: false, definition: false, etymology: false, audio: false });
  });

  it('sorts results by word_id', async () => {
    const wordId1 = `${NS}sort_a`;
    const wordId2 = `${NS}sort_b`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId2, 'x', ['x'],
    ]);
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId1, 'y', ['y'],
    ]);

    const words = await listAllWords(pool, userId);
    const indexA = words.findIndex((w) => w.wordId === wordId1);
    const indexB = words.findIndex((w) => w.wordId === wordId2);

    expect(indexA).toBeLessThan(indexB);
  });
});

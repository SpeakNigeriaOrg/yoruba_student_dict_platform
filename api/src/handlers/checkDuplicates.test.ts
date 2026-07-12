import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { checkDuplicatesHandler } from './checkDuplicates.js';

const NS = 'testdupe_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('checkDuplicatesHandler', () => {
  it('flags an identical spelling as a duplicate', async () => {
    const wordId = `${NS}existingword`;
    const spelling = `${NS}duplicatespelling`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId, spelling, [spelling],
    ]);

    const matches = await checkDuplicatesHandler(pool, spelling, []);

    expect(matches).toContainEqual({ wordId, displayText: spelling, reason: 'identical spelling' });
  });

  it('reports no duplicates for a genuinely new spelling', async () => {
    const matches = await checkDuplicatesHandler(pool, `${NS}completelynewspelling`, []);
    expect(matches).toEqual([]);
  });
});

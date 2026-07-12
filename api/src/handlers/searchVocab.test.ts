import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { searchVocabHandler } from './searchVocab.js';

const NS = 'testsearchv_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string, displayText: string, definition: string | null = null): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    displayText,
    [displayText],
    definition,
  ]);
}

describe('searchVocabHandler', () => {
  it('finds a real seeded word by exact spelling', async () => {
    const wordId = `${NS}exactword`;
    await insertWord(wordId, `${NS}exactspelling`);

    const results = await searchVocabHandler(pool, `${NS}exactspelling`);

    expect(results.some((r) => r.wordId === wordId)).toBe(true);
  });

  it('finds a real seeded word by English definition keyword', async () => {
    const wordId = `${NS}defword`;
    await insertWord(wordId, `${NS}defspelling`, 'searchablekeywordxyz');

    const results = await searchVocabHandler(pool, 'searchablekeywordxyz');

    expect(results.some((r) => r.wordId === wordId)).toBe(true);
  });

  it('returns an empty array for an empty query', async () => {
    expect(await searchVocabHandler(pool, '')).toEqual([]);
  });
});

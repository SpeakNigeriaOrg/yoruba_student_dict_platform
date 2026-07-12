import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { createWord, WordIdAlreadyExistsError } from './createWord.js';

const NS = 'testcw_';
const pool = getTestPool();
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('createWord', () => {
  it('inserts a new atomic word with zero golden_record_components rows', async () => {
    await createWord(
      pool,
      { wordId: `${NS}epo_oil`, displayText: 'epo', syllables: ['e', 'po'], definition: 'oil' },
      curatorUserId,
    );

    const word = await pool.query(
      'select display_text, syllables, definition, entry_type from golden_record where word_id = $1',
      [`${NS}epo_oil`],
    );
    expect(word.rows[0]).toEqual({ display_text: 'epo', syllables: ['e', 'po'], definition: 'oil', entry_type: null });

    const components = await pool.query('select 1 from golden_record_components where word_id = $1', [`${NS}epo_oil`]);
    expect(components.rowCount).toBe(0);
  });

  it('rejects a word_id that already exists', async () => {
    await createWord(pool, { wordId: `${NS}dup_word`, displayText: 'x', syllables: ['x'] }, curatorUserId);
    await expect(
      createWord(pool, { wordId: `${NS}dup_word`, displayText: 'y', syllables: ['y'] }, curatorUserId),
    ).rejects.toThrow(WordIdAlreadyExistsError);
  });

  it('defaults definition to null when not provided', async () => {
    await createWord(pool, { wordId: `${NS}no_def`, displayText: 'x', syllables: ['x'] }, curatorUserId);
    const word = await pool.query<{ definition: string | null }>(
      'select definition from golden_record where word_id = $1',
      [`${NS}no_def`],
    );
    expect(word.rows[0].definition).toBeNull();
  });
});

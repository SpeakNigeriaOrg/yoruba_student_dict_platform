import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { ComponentsNotFoundError, createPhrase, NoComponentsError, WordIdAlreadyExistsError } from './createPhrase.js';

const NS = 'testcp_';
const pool = getTestPool();
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
  await pool.query(
    "insert into golden_record (word_id, display_text, syllables) values ($1, 'a', array['a']), ($2, 'b', array['b'])",
    [`${NS}comp_a`, `${NS}comp_b`],
  );
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('createPhrase', () => {
  it('inserts a phrase with its components in order', async () => {
    await createPhrase(
      pool,
      { wordId: `${NS}ab_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
      curatorUserId,
    );

    const word = await pool.query<{ entry_type: string }>('select entry_type from golden_record where word_id = $1', [
      `${NS}ab_phrase`,
    ]);
    expect(word.rows[0].entry_type).toBe('phrase');

    const components = await pool.query<{ component_word_id: string }>(
      'select component_word_id from golden_record_components where word_id = $1 order by component_position',
      [`${NS}ab_phrase`],
    );
    expect(components.rows.map((r) => r.component_word_id)).toEqual([`${NS}comp_a`, `${NS}comp_b`]);
  });

  it('rejects a phrase with zero components', async () => {
    await expect(
      createPhrase(pool, { wordId: `${NS}empty_phrase`, displayText: 'x', syllables: ['x'], components: [] }, curatorUserId),
    ).rejects.toThrow(NoComponentsError);
  });

  it('rejects a component word_id that does not exist, and writes nothing (the transaction rolls back)', async () => {
    await expect(
      createPhrase(
        pool,
        {
          wordId: `${NS}bad_phrase`,
          displayText: 'x',
          syllables: ['x'],
          components: [`${NS}comp_a`, `${NS}nonexistent`],
        },
        curatorUserId,
      ),
    ).rejects.toThrow(ComponentsNotFoundError);

    const word = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}bad_phrase`]);
    expect(word.rowCount).toBe(0);
  });

  it('rejects a word_id that already exists', async () => {
    await createPhrase(
      pool,
      { wordId: `${NS}dup_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
      curatorUserId,
    );
    await expect(
      createPhrase(
        pool,
        { wordId: `${NS}dup_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
        curatorUserId,
      ),
    ).rejects.toThrow(WordIdAlreadyExistsError);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { excludeExample, ExampleAlreadyExcludedError, ExampleNotFoundError } from './excludeExample.js';
import { listExamples } from './listExamples.js';

const NS = 'testexex_';
const WORD = `${NS}word`;
const pool = getTestPool();
let userId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const user = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, 'Curator', 'curator') returning user_id",
    [`${NS}curator@example.com`],
  );
  userId = user.rows[0].user_id;
  await pool.query("insert into golden_record (word_id, display_text, syllables) values ($1, 'x', array['x'])", [WORD]);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

beforeEach(async () => {
  await pool.query('delete from word_examples where word_id = $1', [WORD]);
});

async function insertExample(): Promise<string> {
  const { rows } = await pool.query<{ example_id: string }>(
    `insert into word_examples (word_id, submitted_by, example_type, example_text, translation, audio_data, recorded_word_text)
     values ($1, $2, 'usage_phrase', 'a phrase', 'a translation', $3, 'x') returning example_id`,
    [WORD, userId, Buffer.from('wav')],
  );
  return rows[0].example_id;
}

describe('excludeExample', () => {
  it('gives the example axis the moderation 0015 designed columns for', async () => {
    // excluded_by / excluded_at / excluded_reason have existed since 0015, described as how
    // "a curator can remove something abusive or off-topic", and no endpoint ever wrote them.
    const exampleId = await insertExample();
    await excludeExample(pool, exampleId, 'off topic', userId);

    const { rows } = await pool.query<{ excluded_reason: string; excluded_by: string }>(
      'select excluded_reason, excluded_by from word_examples where example_id = $1',
      [exampleId],
    );
    expect(rows[0]).toEqual({ excluded_reason: 'off topic', excluded_by: userId });
  });

  it('keeps the row - exclusion is not deletion', async () => {
    const exampleId = await insertExample();
    await excludeExample(pool, exampleId, 'off topic', userId);
    const { rowCount } = await pool.query('select 1 from word_examples where example_id = $1', [exampleId]);
    expect(rowCount).toBe(1);
  });

  it('drops the example out of the live listing', async () => {
    const exampleId = await insertExample();
    expect(await listExamples(pool, WORD, userId)).toHaveLength(1);
    await excludeExample(pool, exampleId, 'off topic', userId);
    expect(await listExamples(pool, WORD, userId)).toHaveLength(0);
  });

  it('requires a reason - an exclusion nobody can explain is not reviewable', async () => {
    const exampleId = await insertExample();
    await expect(excludeExample(pool, exampleId, '   ', userId)).rejects.toThrow(/reason is required/);
  });

  it('refuses to re-stamp an exclusion, so the first actor and reason survive', async () => {
    const exampleId = await insertExample();
    await excludeExample(pool, exampleId, 'first call', userId);
    await expect(excludeExample(pool, exampleId, 'second call', userId)).rejects.toThrow(ExampleAlreadyExcludedError);
    const { rows } = await pool.query<{ excluded_reason: string }>(
      'select excluded_reason from word_examples where example_id = $1',
      [exampleId],
    );
    expect(rows[0].excluded_reason).toBe('first call');
  });

  it('refuses an example that does not exist', async () => {
    await expect(excludeExample(pool, '00000000-0000-0000-0000-000000000000', 'x', userId)).rejects.toThrow(
      ExampleNotFoundError,
    );
  });
});

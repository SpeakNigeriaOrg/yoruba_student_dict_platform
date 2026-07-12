import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { applyDefinitionDecision, MissingDefinitionTextError } from './applyDefinitionDecision.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testdef_';
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

async function insertWord(wordId: string, definition: string | null = null): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'x',
    ['x'],
    definition,
  ]);
}

describe('applyDefinitionDecision', () => {
  it('confirm leaves the current definition untouched and records the decision', async () => {
    const wordId = `${NS}confirm_word`;
    await insertWord(wordId, 'the original text');

    await applyDefinitionDecision(pool, wordId, { definitionAction: 'confirm' }, curatorUserId);

    const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].definition).toBe('the original text');

    const decision = await pool.query<{ decision: unknown }>(
      "select decision from word_decisions where word_id = $1 and axis = 'definition'",
      [wordId],
    );
    // pg serializes the jsonb parameter via JSON.stringify, which drops
    // the undefined-valued definitionText key entirely rather than
    // storing it as null.
    expect(decision.rows[0].decision).toEqual({ definitionAction: 'confirm' });
  });

  it('custom overwrites the definition and records the proposed text', async () => {
    const wordId = `${NS}custom_word`;
    await insertWord(wordId, 'old text');

    await applyDefinitionDecision(pool, wordId, { definitionAction: 'custom', definitionText: 'new text' }, curatorUserId);

    const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].definition).toBe('new text');
  });

  it('rejects custom with no definitionText, and writes nothing', async () => {
    const wordId = `${NS}missing_text_word`;
    await insertWord(wordId, 'old text');

    await expect(
      applyDefinitionDecision(pool, wordId, { definitionAction: 'custom' }, curatorUserId),
    ).rejects.toThrow(MissingDefinitionTextError);

    const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].definition).toBe('old text');

    const decision = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    expect(decision.rowCount).toBe(0);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      applyDefinitionDecision(pool, `${NS}nonexistent`, { definitionAction: 'confirm' }, curatorUserId),
    ).rejects.toThrow(WordNotFoundError);
  });

  it('re-deciding the same axis overwrites the previous decision row rather than duplicating it', async () => {
    const wordId = `${NS}redecide_word`;
    await insertWord(wordId, 'text');

    await applyDefinitionDecision(pool, wordId, { definitionAction: 'confirm', note: 'first pass' }, curatorUserId);
    await applyDefinitionDecision(pool, wordId, { definitionAction: 'custom', definitionText: 'revised' }, curatorUserId);

    const rows = await pool.query("select note, decision from word_decisions where word_id = $1 and axis = 'definition'", [
      wordId,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].decision).toEqual({ definitionAction: 'custom', definitionText: 'revised' });
  });
});

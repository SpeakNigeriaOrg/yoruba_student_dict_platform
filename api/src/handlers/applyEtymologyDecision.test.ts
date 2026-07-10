import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { applyEtymologyDecision, ComponentsNotFoundError, ComponentsRequiredError } from './applyEtymologyDecision.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testety_';
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

async function insertWord(wordId: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [wordId, 'x', ['x']]);
}

describe('applyEtymologyDecision', () => {
  it('confirm_atomic writes no components rows and records the decision', async () => {
    const wordId = `${NS}atomic_word`;
    await insertWord(wordId);

    await applyEtymologyDecision(pool, wordId, { componentsAction: 'confirm_atomic' }, curatorUserId);

    const components = await pool.query('select 1 from golden_record_components where word_id = $1', [wordId]);
    expect(components.rowCount).toBe(0);
  });

  it('accept_proposed replaces golden_record_components with the given list, in order', async () => {
    const wordId = `${NS}accept_word`;
    await insertWord(wordId);

    await applyEtymologyDecision(
      pool,
      wordId,
      { componentsAction: 'accept_proposed', components: [`${NS}comp_a`, `${NS}comp_b`] },
      curatorUserId,
    );

    const rows = await pool.query<{ component_word_id: string }>(
      'select component_word_id from golden_record_components where word_id = $1 order by component_position',
      [wordId],
    );
    expect(rows.rows.map((r) => r.component_word_id)).toEqual([`${NS}comp_a`, `${NS}comp_b`]);
  });

  it('a second accept_proposed call replaces the previous list rather than appending to it', async () => {
    const wordId = `${NS}replace_word`;
    await insertWord(wordId);

    await applyEtymologyDecision(pool, wordId, { componentsAction: 'accept_proposed', components: [`${NS}comp_a`] }, curatorUserId);
    await applyEtymologyDecision(pool, wordId, { componentsAction: 'accept_proposed', components: [`${NS}comp_b`] }, curatorUserId);

    const rows = await pool.query<{ component_word_id: string }>(
      'select component_word_id from golden_record_components where word_id = $1',
      [wordId],
    );
    expect(rows.rows.map((r) => r.component_word_id)).toEqual([`${NS}comp_b`]);
  });

  it('rejects accept_proposed with no components, and writes nothing', async () => {
    const wordId = `${NS}no_components_word`;
    await insertWord(wordId);

    await expect(
      applyEtymologyDecision(pool, wordId, { componentsAction: 'accept_proposed', components: [] }, curatorUserId),
    ).rejects.toThrow(ComponentsRequiredError);

    const decision = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    expect(decision.rowCount).toBe(0);
  });

  it('rejects a nonexistent component word_id, and writes nothing (the transaction rolls back)', async () => {
    const wordId = `${NS}bad_component_word`;
    await insertWord(wordId);

    await expect(
      applyEtymologyDecision(
        pool,
        wordId,
        { componentsAction: 'custom', components: [`${NS}comp_a`, `${NS}nonexistent`] },
        curatorUserId,
      ),
    ).rejects.toThrow(ComponentsNotFoundError);

    const components = await pool.query('select 1 from golden_record_components where word_id = $1', [wordId]);
    expect(components.rowCount).toBe(0);
    const decision = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    expect(decision.rowCount).toBe(0);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      applyEtymologyDecision(pool, `${NS}nonexistent_word`, { componentsAction: 'confirm_atomic' }, curatorUserId),
    ).rejects.toThrow(WordNotFoundError);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { applyDefinitionDecision, MissingDefinitionTextError } from './applyDefinitionDecision.js';
import { getDefinitionReview } from './getDefinitionReview.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testdef_';
const pool = getTestPool();
let curatorUserId: string;
const seededKaikkiSenseIds: string[] = [];

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
  if (seededKaikkiSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededKaikkiSenseIds]);
  }
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

  it('a definitionSourceForm decision round-trips through getDefinitionReview', async () => {
    const wordId = `${NS}sourceform_word`;
    await insertWord(wordId, 'old text');
    // resolveDefinitionSource only honors an explicit definitionSourceForm
    // override if it actually resolves to a real Kaikki record - a real
    // sense needs seeding for this to be a genuine round-trip, not just a
    // "typo, ignored" no-op.
    const senseResult = await pool.query<{ sense_id: string }>(
      `insert into kaikki_senses
         (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
       values ('noun', $1, $1, 'explicit_canonical_tag', 1.0, $1, $2, $3)
       returning sense_id`,
      [`${NS}someothersourceform`, [`${NS}someothersourceform`], ['redirected gloss']],
    );
    seededKaikkiSenseIds.push(senseResult.rows[0].sense_id);
    await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
      senseResult.rows[0].sense_id,
      `${NS}someothersourceform`,
    ]);

    await applyDefinitionDecision(
      pool,
      wordId,
      { definitionAction: 'custom', definitionText: 'redirected text', definitionSourceForm: `${NS}someothersourceform` },
      curatorUserId,
    );

    const decision = await pool.query<{ decision: unknown }>(
      "select decision from word_decisions where word_id = $1 and axis = 'definition'",
      [wordId],
    );
    expect(decision.rows[0].decision).toEqual({
      definitionAction: 'custom',
      definitionText: 'redirected text',
      definitionSourceForm: `${NS}someothersourceform`,
    });

    const review = await getDefinitionReview(pool, wordId);
    expect(review.definitionSourceForm).toBe(`${NS}someothersourceform`);
  });
});

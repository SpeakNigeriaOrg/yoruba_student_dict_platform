import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { applySpellingDecision, NewDisplayTextRequiredError, NoDecisionProvidedError } from './applySpellingDecision.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testspl_';
const pool = getTestPool();
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string, displayText: string, syllables: string[]): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    displayText,
    syllables,
  ]);
}

describe('applySpellingDecision', () => {
  it('keep_ours leaves display_text and syllables untouched and records the decision', async () => {
    const wordId = `${NS}keep_ours_word`;
    await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fon']);

    await applySpellingDecision(pool, wordId, { action: 'keep_ours' }, curatorUserId);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('àgùnfon');
  });

  it('adopt_kaikki overwrites display_text with the given newDisplayText', async () => {
    const wordId = `${NS}adopt_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await applySpellingDecision(pool, wordId, { action: 'adopt_kaikki', newDisplayText: 'kásù' }, curatorUserId);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('kásù');
  });

  it('rejects adopt_kaikki with no newDisplayText, and writes nothing', async () => {
    const wordId = `${NS}adopt_no_target_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await expect(
      applySpellingDecision(pool, wordId, { action: 'adopt_kaikki' }, curatorUserId),
    ).rejects.toThrow(NewDisplayTextRequiredError);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('kasu');
  });

  it('rejects a request with neither action nor syllableAction', async () => {
    const wordId = `${NS}no_decision_word`;
    await insertWord(wordId, 'x', ['x']);

    await expect(applySpellingDecision(pool, wordId, {}, curatorUserId)).rejects.toThrow(NoDecisionProvidedError);
  });

  it('accept_programmatic recomputes syllables from the CURRENT display_text when no spelling change is decided in the same call', async () => {
    const wordId = `${NS}syllable_only_word`;
    // Hand-curated syllables carry a stray underdot the displayText itself
    // doesn't have - same real shape as the agunfon_giraffe fixture case.
    await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fọn']);

    await applySpellingDecision(pool, wordId, { syllableAction: 'accept_programmatic' }, curatorUserId);

    const word = await pool.query<{ syllables: string[]; display_text: string }>(
      'select display_text, syllables from golden_record where word_id = $1',
      [wordId],
    );
    expect(word.rows[0].display_text).toBe('àgùnfon'); // unchanged - no action was decided this call
    expect(word.rows[0].syllables).toEqual(['à', 'gùn', 'fon']);
  });

  it('accept_programmatic recomputes syllables from the NEW display_text when adopt_kaikki happens in the same call', async () => {
    const wordId = `${NS}both_at_once_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await applySpellingDecision(
      pool,
      wordId,
      { action: 'adopt_kaikki', newDisplayText: 'kásù', syllableAction: 'accept_programmatic' },
      curatorUserId,
    );

    const word = await pool.query<{ syllables: string[] }>('select syllables from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].syllables).toEqual(['ká', 'sù']);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      applySpellingDecision(pool, `${NS}nonexistent`, { action: 'keep_ours' }, curatorUserId),
    ).rejects.toThrow(WordNotFoundError);
  });
});

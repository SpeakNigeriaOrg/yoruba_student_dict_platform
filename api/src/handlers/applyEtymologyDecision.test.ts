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

  describe('a phrase is respelled by its components, because that is where its spelling came from', () => {
    // createPhrase derives display_text (parts joined by spaces) and syllables (parts' syllables
    // concatenated) at authoring time. Nothing re-derived them afterwards, so editing a phrase's
    // word list left the phrase spelled as its OLD parts. Not cosmetic: publish compares a
    // recording's frozen recorded_display_text/recorded_syllables to these columns with exact
    // equality, so a silent respell takes the phrase's audio out of the game.
    // The file's shared insertWord fixes display_text to 'x', which cannot show a join.
    async function insertSpelledWord(wordId: string, displayText: string, syllables: string[]) {
      await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
        wordId,
        displayText,
        syllables,
      ]);
    }

    async function insertPhrase(wordId: string, displayText: string, syllables: string[], componentIds: string[]) {
      await pool.query(
        "insert into golden_record (word_id, display_text, syllables, entry_type) values ($1, $2, $3, 'phrase')",
        [wordId, displayText, syllables],
      );
      for (const [position, componentWordId] of componentIds.entries()) {
        await pool.query(
          'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, $2, $3)',
          [wordId, position, componentWordId],
        );
      }
    }

    it('re-derives display_text and syllables from the new word list', async () => {
      const one = `${NS}ph_one`;
      const two = `${NS}ph_two`;
      const three = `${NS}ph_three`;
      const phrase = `${NS}ph_phrase`;
      await insertSpelledWord(one, 'ẹ', ['ẹ']);
      await insertSpelledWord(two, 'jọ̀ọ́', ['jọ̀', 'ọ́']);
      await insertSpelledWord(three, 'gbà', ['gbà']);
      await insertPhrase(phrase, 'ẹ jọ̀ọ́', ['ẹ', 'jọ̀', 'ọ́'], [one, two]);

      await applyEtymologyDecision(
        pool,
        phrase,
        { componentsAction: 'custom', components: [one, three] },
        curatorUserId,
      );

      const row = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [phrase],
      );
      expect(row.rows[0].display_text).toBe('ẹ gbà');
      expect(row.rows[0].syllables).toEqual(['ẹ', 'gbà']);
    });

    it('keeps the submitted ORDER, because the order is the phrase', async () => {
      const one = `${NS}ord_one`;
      const two = `${NS}ord_two`;
      const phrase = `${NS}ord_phrase`;
      await insertSpelledWord(one, 'abo', ['a', 'bo']);
      await insertSpelledWord(two, 'adìyẹ', ['a', 'dì', 'yẹ']);
      await insertPhrase(phrase, 'adìyẹ abo', ['a', 'dì', 'yẹ', 'a', 'bo'], [two, one]);

      await applyEtymologyDecision(pool, phrase, { componentsAction: 'custom', components: [one, two] }, curatorUserId);

      const row = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [phrase],
      );
      expect(row.rows[0].display_text).toBe('abo adìyẹ');
      expect(row.rows[0].syllables).toEqual(['a', 'bo', 'a', 'dì', 'yẹ']);
    });

    it('leaves an ordinary word alone - its spelling is authored, not derived', async () => {
      const part = `${NS}plain_part`;
      const word = `${NS}plain_word`;
      await insertSpelledWord(part, 'abo', ['a', 'bo']);
      await insertSpelledWord(word, 'authored', ['aut', 'hored']);

      await applyEtymologyDecision(
        pool,
        word,
        { componentsAction: 'custom', components: [part] },
        curatorUserId,
      );

      const row = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [word],
      );
      expect(row.rows[0].display_text).toBe('authored');
      expect(row.rows[0].syllables).toEqual(['aut', 'hored']);
    });
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      applyEtymologyDecision(pool, `${NS}nonexistent_word`, { componentsAction: 'confirm_atomic' }, curatorUserId),
    ).rejects.toThrow(WordNotFoundError);
  });
});

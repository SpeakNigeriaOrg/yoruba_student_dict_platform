// The example axis, end to end against real Postgres.
//
// The case this axis exists for is the one the other axes cannot express: two people
// contribute DIFFERENT valid examples for one word and both are kept. Everything else here
// protects that, or protects the boundary with the pronunciation corpus.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { submitExample, ExampleIncompleteError, InvalidExampleTypeError } from './submitExample.js';
import { listExamples } from './listExamples.js';
import { loadAxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testex_';
const pool = getTestPool();
let ada: string;
let ben: string;
let curator: string;

/** Any non-empty bytes - these tests are about the record, not the audio codec. */
const AUDIO = Buffer.from('RIFF....WAVEfake').toString('base64');

const GOOD = {
  exampleType: 'derived_phrase' as const,
  exampleText: 'abo adìyẹ',
  translation: 'hen',
  audioBase64: AUDIO,
};

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const mk = async (email: string, role: 'curator' | 'volunteer') =>
    (
      await pool.query<{ user_id: string }>(
        'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
        [`${NS}${email}`, email, role],
      )
    ).rows[0].user_id;
  ada = await mk('ada@example.com', 'volunteer');
  ben = await mk('ben@example.com', 'volunteer');
  curator = await mk('curator@example.com', 'curator');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

let seq = 0;
async function word(displayText = 'adìyẹ'): Promise<string> {
  seq += 1;
  const wordId = `${NS}w${seq}`;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    displayText,
    ['a', 'dì', 'yẹ'],
    'chicken',
  ]);
  return wordId;
}

describe('submitExample', () => {
  it('stores the phrase, its translation, its type and its audio together', async () => {
    const wordId = await word();
    const { exampleId } = await submitExample(pool, wordId, GOOD, ada);

    const { rows } = await pool.query<{
      example_type: string;
      example_text: string;
      translation: string;
      audio_len: number;
      recorded_word_text: string;
    }>(
      `select example_type, example_text, translation, length(audio_data) as audio_len, recorded_word_text
       from word_examples where example_id = $1`,
      [exampleId],
    );
    expect(rows[0]).toMatchObject({
      example_type: 'derived_phrase',
      example_text: 'abo adìyẹ',
      translation: 'hen',
    });
    expect(Number(rows[0].audio_len)).toBeGreaterThan(0);
    // Frozen from golden_record in the same statement, so it cannot be a copy of a
    // spelling that changed between two round trips.
    expect(rows[0].recorded_word_text).toBe('adìyẹ');
  });

  it('keeps BOTH examples when two people contribute different ones - the case this axis exists for', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await submitExample(
      pool,
      wordId,
      { exampleType: 'usage_phrase', exampleText: 'Adìyẹ ń jẹ', translation: 'the chicken is eating', audioBase64: AUDIO },
      ben,
    );

    const examples = await listExamples(pool, wordId, ada);
    expect(examples).toHaveLength(2);
    expect(examples.map((e) => e.exampleText).sort()).toEqual(['Adìyẹ ń jẹ', 'abo adìyẹ']);
    // Not a conflict to resolve: no fingerprint, no tally, nothing marked contested.
    expect(examples.every((e) => e.exampleText.length > 0)).toBe(true);
  });

  it('replaces the submitter\'s own example rather than adding a second', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await submitExample(pool, wordId, { ...GOOD, exampleText: 'akọ adìyẹ', translation: 'cockerel' }, ada);

    const mine = (await listExamples(pool, wordId, ada)).filter((e) => e.isOwn);
    expect(mine).toHaveLength(1);
    expect(mine[0].exampleText).toBe('akọ adìyẹ');
  });

  it('never touches anyone else\'s when replacing your own', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await submitExample(pool, wordId, { ...GOOD, exampleText: 'ben original' }, ben);
    await submitExample(pool, wordId, { ...GOOD, exampleText: 'ada replaced' }, ada);

    const bens = (await listExamples(pool, wordId, ben)).filter((e) => e.isOwn);
    expect(bens[0].exampleText).toBe('ben original');
  });

  it('requires all three of text, translation and audio', async () => {
    const wordId = await word();
    await expect(submitExample(pool, wordId, { ...GOOD, exampleText: '   ' }, ada)).rejects.toThrow(ExampleIncompleteError);
    await expect(submitExample(pool, wordId, { ...GOOD, translation: '' }, ada)).rejects.toThrow(ExampleIncompleteError);
    await expect(submitExample(pool, wordId, { ...GOOD, audioBase64: '' }, ada)).rejects.toThrow(ExampleIncompleteError);
  });

  it('rejects a type outside the three kinds', async () => {
    const wordId = await word();
    await expect(
      submitExample(pool, wordId, { ...GOOD, exampleType: 'something_else' as never }, ada),
    ).rejects.toThrow(InvalidExampleTypeError);
  });

  it('rejects an example for a word that does not exist, rather than orphaning it', async () => {
    await expect(submitExample(pool, `${NS}nonexistent`, GOOD, ada)).rejects.toThrow(WordNotFoundError);
  });

  it('NEVER writes to utterances - that table is the word\'s pronunciation and feeds the game', async () => {
    // The whole reason word_examples is a separate table. publishToR2/exportGameContent
    // select take-1 utterances per word as that word's audio; an example is a phrase.
    const wordId = await word();
    const before = await pool.query('select count(*)::int n from utterances where word_id = $1', [wordId]);
    await submitExample(pool, wordId, GOOD, ada);
    const after = await pool.query('select count(*)::int n from utterances where word_id = $1', [wordId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].n).toBe(0);
  });
});

describe('axisDecided.example', () => {
  it('is true only for the person who contributed, not for everyone', async () => {
    // Per-user like audio: someone else's example must not read as this person's task done.
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);

    expect((await loadAxisDecided(pool, wordId, ada)).example).toBe(true);
    expect((await loadAxisDecided(pool, wordId, ben)).example).toBe(false);
  });

  it('goes false again when a curator excludes it', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await pool.query(
      "update word_examples set excluded_by = $1, excluded_at = now(), excluded_reason = 'off topic' where word_id = $2",
      [curator, wordId],
    );
    expect((await loadAxisDecided(pool, wordId, ada)).example).toBe(false);
  });
});

describe('exclusion removes it from the collection without destroying it', () => {
  it('hides an excluded example from the list but keeps the row', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await pool.query(
      "update word_examples set excluded_by = $1, excluded_at = now(), excluded_reason = 'spam' where word_id = $2",
      [curator, wordId],
    );

    expect(await listExamples(pool, wordId, ada)).toEqual([]);
    // What someone said survives - same rule 0013 applies to contributions.
    const { rows } = await pool.query<{ example_text: string; excluded_reason: string }>(
      'select example_text, excluded_reason from word_examples where word_id = $1',
      [wordId],
    );
    expect(rows[0]).toMatchObject({ example_text: 'abo adìyẹ', excluded_reason: 'spam' });
  });

  it('re-submitting after exclusion clears the verdict rather than staying suppressed', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await pool.query("update word_examples set excluded_by = $1, excluded_at = now() where word_id = $2", [curator, wordId]);

    await submitExample(pool, wordId, { ...GOOD, exampleText: 'a fresh attempt' }, ada);
    const examples = await listExamples(pool, wordId, ada);
    expect(examples).toHaveLength(1);
    expect(examples[0].exampleText).toBe('a fresh attempt');
  });
});

describe('listExamples', () => {
  it('flags the caller\'s own so the UI can separate them from other people\'s', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    await submitExample(pool, wordId, { ...GOOD, exampleText: 'ben example' }, ben);

    const asBen = await listExamples(pool, wordId, ben);
    expect(asBen.find((e) => e.exampleText === 'ben example')?.isOwn).toBe(true);
    expect(asBen.find((e) => e.exampleText === 'abo adìyẹ')?.isOwn).toBe(false);
  });

  it('returns the audio back as base64, so it can be played', async () => {
    const wordId = await word();
    await submitExample(pool, wordId, GOOD, ada);
    const [example] = await listExamples(pool, wordId, ada);
    expect(example.audioDataBase64).toBe(AUDIO);
  });

  it('reports when the word has been respelled since the example was given', async () => {
    // Phase F made tone corrections routine. The example may still be fine, but that is a
    // curator's call, not something to discover silently.
    const wordId = await word('adiye');
    await submitExample(pool, wordId, GOOD, ada);
    expect((await listExamples(pool, wordId, ada))[0].wordTextChanged).toBe(false);

    await pool.query('update golden_record set display_text = $1 where word_id = $2', ['adìyẹ', wordId]);
    const after = (await listExamples(pool, wordId, ada))[0];
    expect(after.wordTextChanged).toBe(true);
    expect(after.recordedWordText).toBe('adiye');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getSpellingReview } from './getSpellingReview.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testgetspl_';
const pool = getTestPool();
const seededKaikkiSenseIds: string[] = [];

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  if (seededKaikkiSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededKaikkiSenseIds]);
  }
  await pool.end();
});

async function insertWord(wordId: string, displayText: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    displayText,
    [displayText],
  ]);
}

async function insertKaikkiSense(headword: string, canonicalValue: string, orthographyKey: string): Promise<string> {
  const result = await pool.query<{ sense_id: string }>(
    `insert into kaikki_senses
       (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
     values ('verb', $1, $2, 'explicit_canonical_tag', 1.0, $1, $3, $4)
     returning sense_id`,
    [headword, canonicalValue, [canonicalValue], ['test gloss']],
  );
  const senseId = result.rows[0].sense_id;
  seededKaikkiSenseIds.push(senseId);
  await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
    senseId,
    orthographyKey,
  ]);
  return senseId;
}

describe('getSpellingReview', () => {
  it('rejects a word_id that does not exist', async () => {
    await expect(getSpellingReview(pool, `${NS}nonexistent`)).rejects.toThrow(WordNotFoundError);
  });

  it('surfaces a real tone mismatch against Kaikki, with the adoption target and context fields', async () => {
    const wordId = `${NS}mismatchword`;
    const untoned = `${NS}kasu`;
    await insertWord(wordId, untoned);
    await insertKaikkiSense(untoned, `${NS}kásù`, orthographyInsensitiveForm(untoned));

    const result = await getSpellingReview(pool, wordId);

    expect(result.status).toBe('tone_mismatch');
    expect(result.matchedForm).toBe(`${NS}kásù`);
    expect(result.adoptionTarget).toBe(`${NS}kásù`);
    expect(result.axisDecided).toEqual({ spelling: false, definition: false, etymology: false, audio: false });
  });

  it('returns not_in_kaikki with no candidates when this word has no Kaikki sense at all', async () => {
    const wordId = `${NS}nokaikkiword`;
    await insertWord(wordId, `${NS}nokaikkispelling`);

    const result = await getSpellingReview(pool, wordId);

    expect(result.status).toBe('not_in_kaikki');
  });

  it('reflects an already-decided keep_ours spelling decision as verified_keep_ours, not a fresh proposal', async () => {
    const wordId = `${NS}keptword`;
    const untoned = `${NS}beelu`;
    await insertWord(wordId, untoned);
    await insertKaikkiSense(untoned, `${NS}bélú`, orthographyInsensitiveForm(untoned));

    const curatorResult = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}curator`, 'Test Curator'],
    );
    await pool.query(`insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'spelling', $2, $3)`, [
      wordId,
      JSON.stringify({ action: 'keep_ours' }),
      curatorResult.rows[0].user_id,
    ]);

    const result = await getSpellingReview(pool, wordId);

    expect(result.status).toBe('verified_keep_ours');
    expect(result.axisDecided).toEqual({ spelling: true, definition: false, etymology: false, audio: false });
  });

  it('surfaces syllables and definition as context alongside the diagnosis', async () => {
    const wordId = `${NS}contextword`;
    await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
      wordId,
      `${NS}contextspelling`,
      [`${NS}context`, 'spelling'],
      'a definition for context testing',
    ]);

    const result = await getSpellingReview(pool, wordId);

    expect(result.syllables).toEqual([`${NS}context`, 'spelling']);
    expect(result.definition).toBe('a definition for context testing');
  });

  it('reports a syllable split match when the manual and programmatic splits agree', async () => {
    const wordId = `${NS}syllablematch`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId,
      'kasu',
      ['ka', 'su'],
    ]);

    const result = await getSpellingReview(pool, wordId);

    expect(result.syllableSplitStatus).toBe('match');
  });

  it('reports a syllable split mismatch, with both splits, when they disagree', async () => {
    const wordId = `${NS}syllablemismatch`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId,
      'kasu',
      ['kasu'],
    ]);

    const result = await getSpellingReview(pool, wordId);

    expect(result.syllableSplitStatus).toBe('mismatch');
    expect(result.syllableSplitManual).toEqual(['kasu']);
    expect(result.syllableSplitProgrammatic).toEqual(['ka', 'su']);
  });
});

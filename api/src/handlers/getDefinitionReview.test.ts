import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getDefinitionReview } from './getDefinitionReview.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testgetdef_';
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

async function insertWord(wordId: string, displayText: string, definition: string | null = null): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    displayText,
    [displayText],
    definition,
  ]);
}

async function insertKaikkiSense(headword: string, canonicalValue: string, orthographyKey: string, glosses: string[]): Promise<string> {
  const result = await pool.query<{ sense_id: string }>(
    `insert into kaikki_senses
       (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
     values ('noun', $1, $2, 'explicit_canonical_tag', 1.0, $1, $3, $4)
     returning sense_id`,
    [headword, canonicalValue, [canonicalValue], glosses],
  );
  const senseId = result.rows[0].sense_id;
  seededKaikkiSenseIds.push(senseId);
  await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
    senseId,
    orthographyKey,
  ]);
  return senseId;
}

describe('getDefinitionReview', () => {
  it('rejects a word_id that does not exist', async () => {
    await expect(getDefinitionReview(pool, `${NS}nonexistent`)).rejects.toThrow(WordNotFoundError);
  });

  it('proposes a definition from Kaikki glosses when none has been decided yet', async () => {
    const wordId = `${NS}proposeword_leopard`;
    await insertWord(wordId, `${NS}amotekun`);
    await insertKaikkiSense(`${NS}amotekun`, `${NS}amotekun`, orthographyInsensitiveForm(`${NS}amotekun`), ['leopard']);

    const result = await getDefinitionReview(pool, wordId);

    expect(result.definitionStatus).toBe('proposed');
    expect(result.definitionProposed).toBe('leopard');
    expect(result.definitionCurrent).toBeNull();
    expect(result.axisDecided).toEqual({ spelling: false, definition: false, etymology: false, audio: false });
  });

  it('reports missing (not proposed) when there is no current definition and no Kaikki match', async () => {
    const wordId = `${NS}missingword`;
    await insertWord(wordId, `${NS}missingspelling`);

    const result = await getDefinitionReview(pool, wordId);

    expect(result.definitionStatus).toBe('missing');
  });

  it('reflects an already-confirmed definition decision', async () => {
    const wordId = `${NS}confirmedword`;
    await insertWord(wordId, `${NS}confirmedspelling`, 'an already-confirmed definition');

    const curatorResult = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}curator`, 'Test Curator'],
    );
    await pool.query(`insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'definition', $2, $3)`, [
      wordId,
      JSON.stringify({ definitionAction: 'confirm' }),
      curatorResult.rows[0].user_id,
    ]);

    const result = await getDefinitionReview(pool, wordId);

    expect(result.definitionStatus).toBe('confirmed');
    expect(result.definitionCurrent).toBe('an already-confirmed definition');
    expect(result.axisDecided).toEqual({ spelling: false, definition: true, etymology: false, audio: false });
  });

  it('surfaces syllables as context alongside the diagnosis', async () => {
    const wordId = `${NS}contextword`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId,
      `${NS}contextspelling`,
      [`${NS}context`, 'spelling'],
    ]);

    const result = await getDefinitionReview(pool, wordId);

    expect(result.syllables).toEqual([`${NS}context`, 'spelling']);
  });
});

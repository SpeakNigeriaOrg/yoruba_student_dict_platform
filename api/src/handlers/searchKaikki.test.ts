import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { searchKaikkiHandler } from './searchKaikki.js';

const NS = 'testsearchk_';
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

async function insertKaikkiSense(headword: string, canonicalValue: string, orthographyKey: string, glosses: string[]): Promise<void> {
  const result = await pool.query<{ sense_id: string }>(
    `insert into kaikki_senses
       (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
     values ('noun', $1, $2, 'explicit_canonical_tag', 1.0, $1, $3, $4)
     returning sense_id`,
    [headword, canonicalValue, [canonicalValue], glosses],
  );
  seededKaikkiSenseIds.push(result.rows[0].sense_id);
  await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
    result.rows[0].sense_id,
    orthographyKey,
  ]);
}

describe('searchKaikkiHandler', () => {
  it('finds a real seeded sense by exact Yoruba spelling', async () => {
    await insertKaikkiSense(`${NS}kasu`, `${NS}kásù`, `${NS}kasu`, ['test gloss for search']);

    const results = await searchKaikkiHandler(pool, `${NS}kásù`);

    expect(results.some((r) => r.form === `${NS}kásù`)).toBe(true);
  });

  it('finds a real seeded sense by English gloss keyword', async () => {
    await insertKaikkiSense(`${NS}amotekun`, `${NS}amotekun`, `${NS}amotekun`, ['leopardsearchword']);

    const results = await searchKaikkiHandler(pool, 'leopardsearchword');

    expect(results.some((r) => r.form === `${NS}amotekun`)).toBe(true);
  });

  it('returns an empty array for an empty query', async () => {
    expect(await searchKaikkiHandler(pool, '')).toEqual([]);
  });

  it('returns an empty array when nothing matches', async () => {
    expect(await searchKaikkiHandler(pool, `${NS}totallyunmatchedqueryxyz`)).toEqual([]);
  });
});

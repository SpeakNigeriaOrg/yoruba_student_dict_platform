import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { writeSensesToPostgres } from './writeToPostgres.js';
import type { DerivedKaikkiSense } from './types.js';

function getTestPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set - export it before running `npm test` (see the other workspaces\' local.settings.json.example)');
  }
  return new pg.Pool({ connectionString });
}

// This is the only test file that touches the kaikki_* tables (they're
// exclusively owned by this ingestion pipeline, unlike golden_record/users
// which many api/ test files share) - so a plain whole-table
// truncate-before-each is safe, no per-file namespacing needed the way
// api/'s tests required.
const pool = getTestPool();

beforeEach(async () => {
  await pool.query('truncate table kaikki_senses cascade');
  await pool.query('truncate table kaikki_ingestion_runs');
});

afterAll(async () => {
  await pool.query('truncate table kaikki_senses cascade');
  await pool.query('truncate table kaikki_ingestion_runs');
  await pool.end();
});

function makeSense(overrides: Partial<DerivedKaikkiSense> = {}): DerivedKaikkiSense {
  return {
    entryId: 'x',
    pos: 'noun',
    etymologyNumber: null,
    etymologyText: null,
    headword: 'x',
    canonicalForm: { value: 'x', inferenceMethod: 'fallback_headword', confidence: 0.5, originalValue: 'x' },
    standardForms: ['x'],
    glosses: ['a thing'],
    altOfTargets: [],
    componentCandidates: [],
    usedInCandidates: [],
    indexKeys: ['x'],
    derivedFormTexts: [],
    ...overrides,
  };
}

describe('writeSensesToPostgres', () => {
  it('writes senses, keys, and component candidates correctly, and records the ingestion run', async () => {
    const senses: DerivedKaikkiSense[] = [
      makeSense({
        headword: 'ilé',
        canonicalForm: { value: 'ilé', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'ilé' },
        standardForms: ['ilé'],
        glosses: ['home', 'house'],
        indexKeys: ['ile'],
        componentCandidates: [{ form: 'foo', provenance: 'etymology_template' }],
        usedInCandidates: [{ form: 'iléeṣẹ́', provenance: 'synthesized_from_etymology' }],
        etymologyText: 'From proto-Yoruba, cognate with...',
      }),
      makeSense({
        headword: 'dodo',
        canonicalForm: { value: 'dodò', inferenceMethod: 'explicit_canonical_tag', confidence: 1, originalValue: 'dodo' },
        standardForms: ['dodò'],
        glosses: ['fried plantain'],
        indexKeys: ['dodo', 'dodo2'], // ragged - a different key count than the first sense
        componentCandidates: [
          { form: 'di', provenance: 'etymology_template' },
          { form: 'odò', provenance: 'etymology_template' },
        ],
      }),
    ];

    const result = await writeSensesToPostgres(pool, senses, { sourceDate: '2026-07-06', contentHash: 'abc123' });
    expect(result.senseCount).toBe(2);

    const senseRows = await pool.query<{ headword: string; standard_forms: string[]; glosses: string[]; etymology_text: string | null }>(
      'select headword, standard_forms, glosses, etymology_text from kaikki_senses order by headword',
    );
    expect(senseRows.rows).toEqual([
      { headword: 'dodo', standard_forms: ['dodò'], glosses: ['fried plantain'], etymology_text: null },
      { headword: 'ilé', standard_forms: ['ilé'], glosses: ['home', 'house'], etymology_text: 'From proto-Yoruba, cognate with...' },
    ]);

    const keyRows = await pool.query<{ orthography_insensitive_key: string }>(
      'select orthography_insensitive_key from kaikki_sense_keys order by orthography_insensitive_key',
    );
    expect(keyRows.rows.map((r) => r.orthography_insensitive_key)).toEqual(['dodo', 'dodo2', 'ile']);

    const candidateRows = await pool.query<{ form: string; provenance: string; position: number }>(
      'select form, provenance, position from kaikki_component_candidates order by form',
    );
    expect(candidateRows.rows).toEqual([
      { form: 'di', provenance: 'etymology_template', position: 0 },
      { form: 'foo', provenance: 'etymology_template', position: 0 },
      { form: 'odò', provenance: 'etymology_template', position: 1 },
    ]);

    const usedInRows = await pool.query<{ form: string; provenance: string; position: number }>(
      'select form, provenance, position from kaikki_used_in_candidates order by form',
    );
    expect(usedInRows.rows).toEqual([{ form: 'iléeṣẹ́', provenance: 'synthesized_from_etymology', position: 0 }]);

    const runRows = await pool.query<{ source_date: string; sense_count: number; content_hash: string }>(
      'select source_date, sense_count, content_hash from kaikki_ingestion_runs',
    );
    expect(runRows.rows).toHaveLength(1);
    expect(runRows.rows[0].sense_count).toBe(2);
    expect(runRows.rows[0].content_hash).toBe('abc123');
  });

  it('fully replaces the previous run\'s senses, but keeps accumulating kaikki_ingestion_runs as a history log', async () => {
    await writeSensesToPostgres(pool, [makeSense({ headword: 'first' })], { sourceDate: null, contentHash: null });
    await writeSensesToPostgres(pool, [makeSense({ headword: 'second' })], { sourceDate: null, contentHash: null });

    const rows = await pool.query<{ headword: string }>('select headword from kaikki_senses');
    expect(rows.rows).toEqual([{ headword: 'second' }]); // senses: replaced, not accumulated

    const runRows = await pool.query('select 1 from kaikki_ingestion_runs');
    expect(runRows.rowCount).toBe(2); // ingestion_runs: a log of every run, deliberately not FK-linked to kaikki_senses
  });

  it('handles more senses than one insert batch (SENSE_BATCH_SIZE=500) without dropping any', async () => {
    const senses = Array.from({ length: 600 }, (_, i) =>
      makeSense({ headword: `word${i}`, canonicalForm: { value: `word${i}`, inferenceMethod: 'fallback_headword', confidence: 0.5, originalValue: `word${i}` }, indexKeys: [`word${i}`] }),
    );

    const result = await writeSensesToPostgres(pool, senses, { sourceDate: null, contentHash: null });
    expect(result.senseCount).toBe(600);

    const count = await pool.query<{ count: string }>('select count(*) as count from kaikki_senses');
    expect(Number(count.rows[0].count)).toBe(600);

    const keyCount = await pool.query<{ count: string }>('select count(*) as count from kaikki_sense_keys');
    expect(Number(keyCount.rows[0].count)).toBe(600);
  });

  it('handles ragged glosses/standardForms/altOfTargets array lengths across rows in the same batch', async () => {
    const senses = [
      makeSense({ headword: 'a', glosses: ['one'], standardForms: ['a'], altOfTargets: [] }),
      makeSense({ headword: 'b', glosses: ['one', 'two', 'three'], standardForms: ['b', 'bb', 'bbb', 'bbbb'], altOfTargets: ['x', 'y'] }),
      makeSense({ headword: 'c', glosses: [], standardForms: ['c'], altOfTargets: [] }),
    ];

    await writeSensesToPostgres(pool, senses, { sourceDate: null, contentHash: null });

    const rows = await pool.query<{ headword: string; glosses: string[]; standard_forms: string[] }>(
      'select headword, glosses, standard_forms from kaikki_senses order by headword',
    );
    expect(rows.rows).toEqual([
      { headword: 'a', glosses: ['one'], standard_forms: ['a'] },
      { headword: 'b', glosses: ['one', 'two', 'three'], standard_forms: ['b', 'bb', 'bbb', 'bbbb'] },
      { headword: 'c', glosses: [], standard_forms: ['c'] },
    ]);
  });
});

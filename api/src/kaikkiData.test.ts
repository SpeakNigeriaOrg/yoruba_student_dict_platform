import { afterAll, describe, expect, it } from 'vitest';
import { getTestPool } from './testSupport.js';
import { loadKaikkiSensesForKey } from './kaikkiData.js';

const pool = getTestPool();
const seededSenseIds: string[] = [];

afterAll(async () => {
  if (seededSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededSenseIds]);
  }
  await pool.end();
});

describe('loadKaikkiSensesForKey', () => {
  it('returns [] for a key with no senses', async () => {
    const senses = await loadKaikkiSensesForKey(pool, 'zzz_definitely_not_a_real_key_zzz');
    expect(senses).toEqual([]);
  });

  it('round-trips a real word from the ingested corpus (ilé)', async () => {
    const senses = await loadKaikkiSensesForKey(pool, 'ile');
    expect(senses.length).toBeGreaterThan(0);
    const ile = senses.find((s) => s.canonicalForm.value === 'ilé');
    expect(ile).toBeDefined();
    expect(ile!.pos).toBe('noun');
    expect(ile!.canonicalForm.inferenceMethod).toBe('explicit_canonical_tag');
    expect(ile!.glosses.length).toBeGreaterThan(0);
    expect(Array.isArray(ile!.componentCandidates)).toBe(true);
    expect(Array.isArray(ile!.usedInCandidates)).toBe(true);
    expect(ile!.derivedForms).toEqual([]);
  });

  it("round-trips mọ̀'s real usedInCandidates from the ingested corpus (33 distinct compounds)", async () => {
    const senses = await loadKaikkiSensesForKey(pool, 'mo');
    const mo = senses.find((s) => s.canonicalForm.value === 'mọ̀');
    expect(mo).toBeDefined();
    expect(mo!.usedInCandidates).toHaveLength(33);
    expect(mo!.usedInCandidates!.every((c) => c.provenance === 'synthesized_from_etymology')).toBe(true);
    expect(mo!.usedInCandidates!.map((c) => c.form)).toContain('àmọ̀tẹ́kùn');
  });

  it('round-trips componentCandidates and usedInCandidates in position order', async () => {
    const senseResult = await pool.query<{ sense_id: string }>(
      `insert into kaikki_senses
         (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
       values ('noun', 'testword', 'testwórd', 'explicit_canonical_tag', 1.0, 'testword', $1, $2)
       returning sense_id`,
      [['testwórd'], ['a test gloss']],
    );
    const senseId = senseResult.rows[0].sense_id;
    seededSenseIds.push(senseId);
    await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
      senseId,
      'testkeyzzz',
    ]);
    await pool.query(
      `insert into kaikki_component_candidates (sense_id, position, form, provenance) values
         ($1, 0, 'first', 'etymology_template'),
         ($1, 1, 'second', 'derived_reciprocal')`,
      [senseId],
    );
    await pool.query(
      `insert into kaikki_used_in_candidates (sense_id, position, form, provenance) values
         ($1, 0, 'compoundOne', 'synthesized_from_etymology'),
         ($1, 1, 'compoundTwo', 'synthesized_from_etymology')`,
      [senseId],
    );

    const senses = await loadKaikkiSensesForKey(pool, 'testkeyzzz');
    expect(senses).toHaveLength(1);
    expect(senses[0].componentCandidates).toEqual([
      { form: 'first', provenance: 'etymology_template' },
      { form: 'second', provenance: 'derived_reciprocal' },
    ]);
    expect(senses[0].usedInCandidates).toEqual([
      { form: 'compoundOne', provenance: 'synthesized_from_etymology' },
      { form: 'compoundTwo', provenance: 'synthesized_from_etymology' },
    ]);
  });
});

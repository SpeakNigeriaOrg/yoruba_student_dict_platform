import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getEtymologyReview } from './getEtymologyReview.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testgetety_';
const pool = getTestPool();
const seededKaikkiSenseIds: string[] = [];
let userId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}requester`, 'Test Requester'],
  );
  userId = result.rows[0].user_id;
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

async function insertKaikkiSense(
  headword: string,
  canonicalValue: string,
  orthographyKey: string,
  componentCandidates: Array<{ form: string; provenance: string }>,
  usedInCandidates: Array<{ form: string; provenance: string }>,
  etymologyText: string | null = null,
): Promise<string> {
  const result = await pool.query<{ sense_id: string }>(
    `insert into kaikki_senses
       (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses, etymology_text)
     values ('noun', $1, $2, 'explicit_canonical_tag', 1.0, $1, $3, $4, $5)
     returning sense_id`,
    [headword, canonicalValue, [canonicalValue], ['test gloss'], etymologyText],
  );
  const senseId = result.rows[0].sense_id;
  seededKaikkiSenseIds.push(senseId);
  await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
    senseId,
    orthographyKey,
  ]);
  for (const [position, c] of componentCandidates.entries()) {
    await pool.query(
      'insert into kaikki_component_candidates (sense_id, position, form, provenance) values ($1, $2, $3, $4)',
      [senseId, position, c.form, c.provenance],
    );
  }
  for (const [position, c] of usedInCandidates.entries()) {
    await pool.query(
      'insert into kaikki_used_in_candidates (sense_id, position, form, provenance) values ($1, $2, $3, $4)',
      [senseId, position, c.form, c.provenance],
    );
  }
  return senseId;
}

describe('getEtymologyReview', () => {
  it('rejects a word_id that does not exist', async () => {
    await expect(getEtymologyReview(pool, `${NS}nonexistent`, userId)).rejects.toThrow(WordNotFoundError);
  });

  it('surfaces both componentsProposal (forward) and usedInProposal (reverse), resolved against real golden_record entries', async () => {
    const compoundId = `${NS}compound_word`;
    const partOneId = `${NS}part_one`;
    const partTwoId = `${NS}part_two`;
    const usedInTargetId = `${NS}used_in_target`;

    await insertWord(compoundId, `${NS}compoundspelling`);
    await insertWord(partOneId, `${NS}partone`);
    await insertWord(partTwoId, `${NS}parttwo`);
    await insertWord(usedInTargetId, `${NS}usedintarget`);

    await insertKaikkiSense(
      `${NS}compoundspelling`,
      `${NS}compoundspelling`,
      orthographyInsensitiveForm(`${NS}compoundspelling`),
      [
        { form: `${NS}partone`, provenance: 'etymology_template' },
        { form: `${NS}parttwo`, provenance: 'etymology_template' },
      ],
      [{ form: `${NS}usedintarget`, provenance: 'synthesized_from_etymology' }],
    );

    const result = await getEtymologyReview(pool, compoundId, userId);

    expect(result.wordId).toBe(compoundId);
    expect(result.componentsProposal).toHaveLength(2);
    expect(result.componentsProposal.map((p) => p.wordId)).toEqual(
      expect.arrayContaining([partOneId, partTwoId]),
    );
    expect(result.usedInProposal).toHaveLength(1);
    expect(result.usedInProposal[0]).toMatchObject({
      wordId: usedInTargetId,
      provenance: 'synthesized_from_etymology',
    });
  });

  it('surfaces plaintext etymologyText even when there are no structured component candidates to propose', async () => {
    const wordId = `${NS}plaintext_word`;
    await insertWord(wordId, `${NS}plaintextspelling`);

    await insertKaikkiSense(
      `${NS}plaintextspelling`,
      `${NS}plaintextspelling`,
      orthographyInsensitiveForm(`${NS}plaintextspelling`),
      [],
      [],
      'Clipping of an older form; no structured breakdown recorded by Kaikki.',
    );

    const result = await getEtymologyReview(pool, wordId, userId);

    expect(result.componentsProposal).toEqual([]);
    expect(result.etymologyText).toBe('Clipping of an older form; no structured breakdown recorded by Kaikki.');
  });

  it('defaults an atomic word (no Kaikki sense, no components) to a self-referencing components list with empty proposals', async () => {
    const wordId = `${NS}atomic_word`;
    await insertWord(wordId, `${NS}atomicspelling`);

    const result = await getEtymologyReview(pool, wordId, userId);

    expect(result.components).toEqual([wordId]);
    expect(result.componentsProposal).toEqual([]);
    expect(result.usedInProposal).toEqual([]);
    expect(result.usedAsComponentOf).toEqual([]);
  });

  it('surfaces syllables, definition, and per-axis decided status as read-only context', async () => {
    const wordId = `${NS}context_word`;
    await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
      wordId,
      `${NS}contextspelling`,
      [`${NS}context`, 'spelling'],
      'a definition for context testing',
    ]);
    const curatorResult = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}context_curator`, 'Test Curator'],
    );
    await pool.query(`insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'definition', $2, $3)`, [
      wordId,
      JSON.stringify({ definitionAction: 'confirm' }),
      curatorResult.rows[0].user_id,
    ]);

    const result = await getEtymologyReview(pool, wordId, userId);

    expect(result.syllables).toEqual([`${NS}context`, 'spelling']);
    expect(result.definition).toBe('a definition for context testing');
    expect(result.axisDecided).toEqual({ spelling: false, definition: true, etymology: false, audio: false });
  });

  it('reports definition as null and every axis undecided for a freshly-added word', async () => {
    const wordId = `${NS}fresh_word`;
    await insertWord(wordId, `${NS}freshspelling`);

    const result = await getEtymologyReview(pool, wordId, userId);

    expect(result.definition).toBeNull();
    expect(result.axisDecided).toEqual({ spelling: false, definition: false, etymology: false, audio: false });
  });
});

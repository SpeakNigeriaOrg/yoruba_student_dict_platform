import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getEtymologyReview } from './getEtymologyReview.js';
import { WordNotFoundError } from './errors.js';
import { writeCitationInTransaction } from './upstreamCitations.js';

const NS = 'testgetety_';
const pool = getTestPool();
const seededKaikkiSenseIds: string[] = [];
let userId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
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

  it('surfaces componentsProposal, resolved against real golden_record entries', async () => {
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
    // The reverse direction is NOT returned, even though this fixture has a real used-in candidate
    // (usedInTargetId) that resolves. Nothing on the etymology screen could ever act on it -
    // applyEtymologyDecision only writes component rows for the word under review - so it was
    // decoration on 47 of 80 cited words, and after the request flow landed the shared row
    // component told a reader to add it as a PART of this word, which is the inverse relationship.
    // Derived terms are the example axis's subject.
    expect('usedInProposal' in result).toBe(false);
    expect('usedAsComponentOf' in result).toBe(false);
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
    expect(result.entryType).toBeNull();
  });

  it('reports entryType so the screen can ask a phrase the right question', async () => {
    // A phrase's identity IS its constituent words, so "does this break into parts?" and "it has
    // no parts" are not available answers about one - and the screen was offering both, because the
    // response carried no way to tell a phrase from a word.
    const partId = `${NS}phrase_part`;
    const phraseId = `${NS}phrase_entry`;
    await insertWord(partId, `${NS}phrasepart`);
    await pool.query(
      "insert into golden_record (word_id, display_text, syllables, entry_type) values ($1, $2, $3, 'phrase')",
      [phraseId, `${NS}phrasepart ${NS}phrasepart`, [`${NS}phrasepart`]],
    );
    await pool.query(
      'insert into golden_record_components (word_id, component_word_id, component_position) values ($1, $2, 0)',
      [phraseId, partId],
    );

    expect((await getEtymologyReview(pool, phraseId, userId)).entryType).toBe('phrase');
    expect((await getEtymologyReview(pool, partId, userId)).entryType).toBeNull();
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
      "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}context_curator`, 'Test Curator'],
    );
    await pool.query(`insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', $2, $3)`, [
      wordId,
      JSON.stringify({ definitionAction: 'confirm' }),
      curatorResult.rows[0].user_id,
    ]);

    const result = await getEtymologyReview(pool, wordId, userId);

    expect(result.syllables).toEqual([`${NS}context`, 'spelling']);
    expect(result.definition).toBe('a definition for context testing');
    expect(result.axisDecided).toEqual({ entry: true, etymology: false, audio: false, audioDiverges: false, example: false });
  });

  it('reports definition as null and every axis undecided for a freshly-added word', async () => {
    const wordId = `${NS}fresh_word`;
    await insertWord(wordId, `${NS}freshspelling`);

    const result = await getEtymologyReview(pool, wordId, userId);

    expect(result.definition).toBeNull();
    expect(result.axisDecided).toEqual({ entry: false, etymology: false, audio: false, audioDiverges: false, example: false });
  });
});

describe('clues from other Wiktionary pages (derived terms)', () => {
  const E = 'testgetety-entry-';

  afterAll(async () => {
    await pool.query('delete from kaikki_senses where entry_id like $1', [`${E}%`]);
  });

  async function sense(entryId: string, spelling: string, glosses: string[], candidates: Array<{ form: string; provenance: string; entryIds?: string[] }>) {
    const { rows } = await pool.query<{ sense_id: string }>(
      `insert into kaikki_senses
         (entry_id, pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
       values ($1, 'noun', $2, $2, 'explicit_canonical_tag', 1.0, $2, $3, $4) returning sense_id`,
      [entryId, spelling, [spelling], glosses],
    );
    await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
      rows[0].sense_id,
      orthographyInsensitiveForm(spelling),
    ]);
    for (const [position, c] of candidates.entries()) {
      await pool.query(
        'insert into kaikki_component_candidates (sense_id, position, form, provenance, candidate_entry_ids) values ($1, $2, $3, $4, $5)',
        [rows[0].sense_id, position, c.form, c.provenance, c.entryIds ?? null],
      );
    }
  }

  it("keeps a parent page's listing out of the word's own etymology, and names its ambiguity at both ends", async () => {
    const parent = `${NS}crownspelling`;
    const child = `${NS}crownedspelling`;
    // Two etymologies spelled like the parent both list the child; we hold the first.
    await sense(`${E}crown-1`, parent, ['crown'], []);
    await sense(`${E}crown-2`, parent, ['a kind of bird'], []);
    await insertWord(`${NS}crown`, parent);
    await writeCitationInTransaction(pool, `${NS}crown`, { entryId: `${E}crown-1` }, userId);
    // The child's own etymology names one part; the listing reached it and another etymology
    // spelled the same way.
    const clue = { form: parent, provenance: 'derived_reciprocal', entryIds: [`${E}crown-1`, `${E}crown-2`] };
    await sense(`${E}crowned-1`, child, ['one who wears a crown'], [{ form: `${NS}ownpart`, provenance: 'etymology_template' }, clue]);
    await sense(`${E}crowned-2`, child, ['something else entirely'], [clue]);
    await insertWord(`${NS}crowned`, child);
    await writeCitationInTransaction(pool, `${NS}crowned`, { entryId: `${E}crowned-1` }, userId);

    const review = await getEtymologyReview(pool, `${NS}crowned`, userId);

    expect(review.componentsProposal.map((p) => p.kaikkiForm)).toEqual([`${NS}ownpart`]);
    expect(review.derivedTermClues).toEqual([
      {
        form: parent,
        parents: [
          expect.objectContaining({ entryId: `${E}crown-1`, glosses: ['crown'], held: { wordId: `${NS}crown`, displayText: parent } }),
          expect.objectContaining({ entryId: `${E}crown-2`, glosses: ['a kind of bird'], held: null }),
        ],
        otherWordsWithThisSpelling: 1,
      },
    ]);
  });
});

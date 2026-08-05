// Replaces applySpellingDecision.test.ts and applyDefinitionDecision.test.ts,
// which covered the two halves separately. Carries over their cases (keep_ours,
// adopt_kaikki server-side verification, syllable recompute, confirm vs custom
// definition text, upsert-on-repeat) and adds the ones the merge itself
// introduces: both halves required, and both applied in ONE transaction.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import {
  applyEntryDecision,
  IncompleteEntryDecisionError,
  KaikkiVerificationMismatchError,
  MissingDefinitionTextError,
  NewDisplayTextRequiredError,
} from './applyEntryDecision.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testentry_';
const pool = getTestPool();
let curatorUserId: string;
const seededKaikkiSenseIds: string[] = [];

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;

  // A real kaikki_senses/kaikki_sense_keys row so adopt_kaikki's server-side
  // verification has something genuine to check 'kasu' -> 'kásù' against:
  // untoned headword, explicit canonical tag pointing at the toned form.
  await insertKaikkiSense('kasu', 'kásù', 'kasu');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  if (seededKaikkiSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededKaikkiSenseIds]);
  }
  await pool.end();
});

async function insertWord(wordId: string, displayText: string, syllables: string[], definition: string | null = null) {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    displayText,
    syllables,
    definition,
  ]);
}

async function insertKaikkiSense(headword: string, canonicalValue: string, orthographyKey: string): Promise<void> {
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
}

function readDecision(wordId: string) {
  return pool.query<{ decision: Record<string, unknown>; note: string | null; decided_by: string }>(
    "select decision, note, decided_by from word_decisions where word_id = $1 and axis = 'entry'",
    [wordId],
  );
}

describe('applyEntryDecision', () => {
  describe('atomicity: both halves required', () => {
    it('rejects a spelling-only decision', async () => {
      const wordId = `${NS}spelling_only`;
      await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fon']);

      await expect(applyEntryDecision(pool, wordId, { action: 'keep_ours' }, curatorUserId)).rejects.toBeInstanceOf(
        IncompleteEntryDecisionError,
      );

      // Nothing written at all - not a partial row.
      const decision = await readDecision(wordId);
      expect(decision.rowCount).toBe(0);
    });

    it('rejects a definition-only decision', async () => {
      const wordId = `${NS}definition_only`;
      await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fon']);

      await expect(
        applyEntryDecision(pool, wordId, { definitionAction: 'confirm' }, curatorUserId),
      ).rejects.toBeInstanceOf(IncompleteEntryDecisionError);

      const decision = await readDecision(wordId);
      expect(decision.rowCount).toBe(0);
    });

    it('names which half is missing', async () => {
      const wordId = `${NS}which_half`;
      await insertWord(wordId, 'epo', ['e', 'po']);
      await expect(applyEntryDecision(pool, wordId, { action: 'keep_ours' }, curatorUserId)).rejects.toThrow(
        /definitionAction is required/,
      );
      await expect(applyEntryDecision(pool, wordId, { definitionAction: 'confirm' }, curatorUserId)).rejects.toThrow(
        /action is required/,
      );
    });
  });

  describe('one row, both halves', () => {
    it('records spelling and definition fields as siblings in a single decision', async () => {
      const wordId = `${NS}both_halves`;
      await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fon'], 'giraffe');

      await applyEntryDecision(
        pool,
        wordId,
        { action: 'keep_ours', definitionAction: 'confirm', note: 'both at once' },
        curatorUserId,
      );

      const decision = await readDecision(wordId);
      expect(decision.rowCount).toBe(1);
      expect(decision.rows[0].decision).toMatchObject({ action: 'keep_ours', definitionAction: 'confirm' });
      expect(decision.rows[0].note).toBe('both at once');
      expect(decision.rows[0].decided_by).toBe(curatorUserId);
    });

    it('keep_ours leaves display_text and syllables untouched', async () => {
      const wordId = `${NS}keep_ours_word`;
      await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fon']);

      await applyEntryDecision(pool, wordId, { action: 'keep_ours', definitionAction: 'confirm' }, curatorUserId);

      const word = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(word.rows[0].display_text).toBe('àgùnfon');
      expect(word.rows[0].syllables).toEqual(['à', 'gùn', 'fon']);
    });

    it("definitionAction 'custom' overwrites golden_record.definition", async () => {
      const wordId = `${NS}custom_def`;
      await insertWord(wordId, 'epo', ['e', 'po'], 'old text');

      await applyEntryDecision(
        pool,
        wordId,
        { action: 'keep_ours', definitionAction: 'custom', definitionText: 'palm oil' },
        curatorUserId,
      );

      const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
      expect(word.rows[0].definition).toBe('palm oil');
    });

    it("definitionAction 'confirm' leaves the existing definition text alone", async () => {
      const wordId = `${NS}confirm_def`;
      await insertWord(wordId, 'epo', ['e', 'po'], 'palm oil');

      await applyEntryDecision(pool, wordId, { action: 'keep_ours', definitionAction: 'confirm' }, curatorUserId);

      const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
      expect(word.rows[0].definition).toBe('palm oil');
    });

    it("rejects definitionAction 'custom' with no definitionText", async () => {
      const wordId = `${NS}custom_no_text`;
      await insertWord(wordId, 'epo', ['e', 'po']);
      await expect(
        applyEntryDecision(pool, wordId, { action: 'keep_ours', definitionAction: 'custom' }, curatorUserId),
      ).rejects.toBeInstanceOf(MissingDefinitionTextError);
    });

    it('applies a spelling change and a definition change together', async () => {
      const wordId = `${NS}both_changes`;
      await insertWord(wordId, 'kasu', ['ka', 'su'], 'old gloss');

      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'adopt_kaikki',
          newDisplayText: 'kásù',
          syllableAction: 'accept_programmatic',
          definitionAction: 'custom',
          definitionText: 'to fail',
        },
        curatorUserId,
      );

      const word = await pool.query<{ display_text: string; syllables: string[]; definition: string }>(
        'select display_text, syllables, definition from golden_record where word_id = $1',
        [wordId],
      );
      expect(word.rows[0].display_text).toBe('kásù');
      // Recomputed from the spelling this word BECAME, not the one on record.
      expect(word.rows[0].syllables).toEqual(['ká', 'sù']);
      expect(word.rows[0].definition).toBe('to fail');
    });
  });

  describe('adopt_kaikki server-side verification', () => {
    it('requires newDisplayText', async () => {
      const wordId = `${NS}adopt_no_text`;
      await insertWord(wordId, 'kasu', ['ka', 'su']);
      await expect(
        applyEntryDecision(pool, wordId, { action: 'adopt_kaikki', definitionAction: 'confirm' }, curatorUserId),
      ).rejects.toBeInstanceOf(NewDisplayTextRequiredError);
    });

    it('rejects a newDisplayText the Kaikki data does not support', async () => {
      const wordId = `${NS}adopt_mismatch`;
      await insertWord(wordId, 'kasu', ['ka', 'su']);
      await expect(
        applyEntryDecision(
          pool,
          wordId,
          { action: 'adopt_kaikki', newDisplayText: 'totally-made-up', definitionAction: 'confirm' },
          curatorUserId,
        ),
      ).rejects.toBeInstanceOf(KaikkiVerificationMismatchError);
    });

    it('rolls the whole decision back when verification fails - including the definition half', async () => {
      const wordId = `${NS}adopt_rollback`;
      await insertWord(wordId, 'kasu', ['ka', 'su'], 'original gloss');

      await expect(
        applyEntryDecision(
          pool,
          wordId,
          {
            action: 'adopt_kaikki',
            newDisplayText: 'wrong',
            definitionAction: 'custom',
            definitionText: 'should not survive',
          },
          curatorUserId,
        ),
      ).rejects.toBeInstanceOf(KaikkiVerificationMismatchError);

      const word = await pool.query<{ display_text: string; definition: string }>(
        'select display_text, definition from golden_record where word_id = $1',
        [wordId],
      );
      expect(word.rows[0].display_text).toBe('kasu');
      expect(word.rows[0].definition).toBe('original gloss');
      const decision = await readDecision(wordId);
      expect(decision.rowCount).toBe(0);
    });
  });

  it('upserts on a repeat decision rather than inserting a second row', async () => {
    const wordId = `${NS}upsert_word`;
    await insertWord(wordId, 'epo', ['e', 'po'], 'first');

    await applyEntryDecision(
      pool,
      wordId,
      { action: 'keep_ours', definitionAction: 'custom', definitionText: 'first', note: 'first pass' },
      curatorUserId,
    );
    await applyEntryDecision(
      pool,
      wordId,
      { action: 'keep_ours', definitionAction: 'custom', definitionText: 'second', note: 'second pass' },
      curatorUserId,
    );

    const decision = await readDecision(wordId);
    expect(decision.rowCount).toBe(1);
    expect(decision.rows[0].note).toBe('second pass');
    const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].definition).toBe('second');
  });

  it('throws WordNotFoundError for an unknown word_id', async () => {
    await expect(
      applyEntryDecision(pool, `${NS}nonexistent`, { action: 'keep_ours', definitionAction: 'confirm' }, curatorUserId),
    ).rejects.toBeInstanceOf(WordNotFoundError);
  });
});

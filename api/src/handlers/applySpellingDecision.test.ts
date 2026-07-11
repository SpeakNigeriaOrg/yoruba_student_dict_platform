import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import {
  applySpellingDecision,
  KaikkiVerificationMismatchError,
  NewDisplayTextRequiredError,
  NoDecisionProvidedError,
} from './applySpellingDecision.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testspl_';
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

  // Seeds a real kaikki_senses/kaikki_sense_keys row so adopt_kaikki's new
  // server-side verification (against Postgres, not a trusted client value)
  // has something real to check 'kasu' -> 'kásù' against - mirrors a real
  // Kaikki record: headword/displayText 'kasu' untoned, explicit canonical
  // tag pointing at the fully-toned 'kásù'.
  await insertKaikkiSense('kasu', 'kásù', 'kasu');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  if (seededKaikkiSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededKaikkiSenseIds]);
  }
  await pool.end();
});

async function insertWord(wordId: string, displayText: string, syllables: string[]): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    displayText,
    syllables,
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

describe('applySpellingDecision', () => {
  it('keep_ours leaves display_text and syllables untouched and records the decision', async () => {
    const wordId = `${NS}keep_ours_word`;
    await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fon']);

    await applySpellingDecision(pool, wordId, { action: 'keep_ours' }, curatorUserId);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('àgùnfon');
  });

  it('adopt_kaikki overwrites display_text with the given newDisplayText', async () => {
    const wordId = `${NS}adopt_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await applySpellingDecision(pool, wordId, { action: 'adopt_kaikki', newDisplayText: 'kásù' }, curatorUserId);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('kásù');
  });

  it('rejects adopt_kaikki with no newDisplayText, and writes nothing', async () => {
    const wordId = `${NS}adopt_no_target_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await expect(
      applySpellingDecision(pool, wordId, { action: 'adopt_kaikki' }, curatorUserId),
    ).rejects.toThrow(NewDisplayTextRequiredError);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('kasu');
  });

  it('rejects adopt_kaikki when newDisplayText does not match what Kaikki data actually says, and writes nothing', async () => {
    const wordId = `${NS}adopt_mismatch_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await expect(
      applySpellingDecision(pool, wordId, { action: 'adopt_kaikki', newDisplayText: 'kùsá' }, curatorUserId),
    ).rejects.toThrow(KaikkiVerificationMismatchError);

    const word = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].display_text).toBe('kasu');
  });

  it('rejects adopt_kaikki when the word has no Kaikki data at all to verify against', async () => {
    const wordId = `${NS}adopt_no_kaikki_data_word`;
    await insertWord(wordId, 'zzznotinkaikki', ['zzz']);

    await expect(
      applySpellingDecision(pool, wordId, { action: 'adopt_kaikki', newDisplayText: 'whatever' }, curatorUserId),
    ).rejects.toThrow(KaikkiVerificationMismatchError);
  });

  it('rejects a request with neither action nor syllableAction', async () => {
    const wordId = `${NS}no_decision_word`;
    await insertWord(wordId, 'x', ['x']);

    await expect(applySpellingDecision(pool, wordId, {}, curatorUserId)).rejects.toThrow(NoDecisionProvidedError);
  });

  it('accept_programmatic recomputes syllables from the CURRENT display_text when no spelling change is decided in the same call', async () => {
    const wordId = `${NS}syllable_only_word`;
    // Hand-curated syllables carry a stray underdot the displayText itself
    // doesn't have - same real shape as the agunfon_giraffe fixture case.
    await insertWord(wordId, 'àgùnfon', ['à', 'gùn', 'fọn']);

    await applySpellingDecision(pool, wordId, { syllableAction: 'accept_programmatic' }, curatorUserId);

    const word = await pool.query<{ syllables: string[]; display_text: string }>(
      'select display_text, syllables from golden_record where word_id = $1',
      [wordId],
    );
    expect(word.rows[0].display_text).toBe('àgùnfon'); // unchanged - no action was decided this call
    expect(word.rows[0].syllables).toEqual(['à', 'gùn', 'fon']);
  });

  it('accept_programmatic recomputes syllables from the NEW display_text when adopt_kaikki happens in the same call', async () => {
    const wordId = `${NS}both_at_once_word`;
    await insertWord(wordId, 'kasu', ['ka', 'su']);

    await applySpellingDecision(
      pool,
      wordId,
      { action: 'adopt_kaikki', newDisplayText: 'kásù', syllableAction: 'accept_programmatic' },
      curatorUserId,
    );

    const word = await pool.query<{ syllables: string[] }>('select syllables from golden_record where word_id = $1', [
      wordId,
    ]);
    expect(word.rows[0].syllables).toEqual(['ká', 'sù']);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      applySpellingDecision(pool, `${NS}nonexistent`, { action: 'keep_ours' }, curatorUserId),
    ).rejects.toThrow(WordNotFoundError);
  });
});

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
  RespellMismatchError,
  RespellSyllablesRequiredError,
} from './applyEntryDecision.js';
import { WordNotFoundError } from './errors.js';
import { fingerprintOutcome } from '@yoruba-student-dict-platform/shared';

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

  describe('respell wins over accept_programmatic, so the row and its fingerprint agree', () => {
    // Both can arrive in one request - EntryReview forwards syllableAction whenever it is set, and
    // any tone or letter edit also produces a respell. Before the guard the two writes raced and
    // the row kept the programmatic split, while resolveEntryOutcome tests `respelled` first and
    // fingerprinted the authored one. A word_decisions.value_fingerprint describing a split the
    // row does not hold makes that word read as permanently dissented: nothing can ever match it
    // again.
    it('keeps the authored split, and the stored fingerprint describes what the row holds', async () => {
      const wordId = `${NS}respell_wins`;
      await insertWord(wordId, 'kasun', ['ka', 'sun'], 'a made-up word');

      // An authored split that re-deriving would LOSE: the reviewer says the final nasal is its own
      // syllable while writing it bare, which is legal Yoruba - the macron convention is not
      // universal - and is exactly the residual case where the stored split has to carry
      // information the spelling does not. syllabifyWord('kasun') returns ['ka','sun'], so the two
      // answers genuinely differ here, which is what makes this a test of the guard rather than of
      // a coincidence. (A split freed through the tone grid would agree with re-derivation, by
      // construction - so it could never have exposed this.)
      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'kasun',
          newSyllables: ['ka', 'su', 'n'],
          syllableAction: 'accept_programmatic',
          definitionAction: 'confirm',
        },
        curatorUserId,
      );

      const word = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(word.rows[0].display_text).toBe('kasun');
      expect(word.rows[0].syllables).toEqual(['ka', 'su', 'n']);

      // The row and the fingerprint must describe the same word. Recomputed from what is actually
      // stored, which is the comparison that was failing.
      const decision = await pool.query<{ value_fingerprint: string }>(
        'select value_fingerprint from word_decisions where word_id = $1 and axis = $2',
        [wordId, 'entry'],
      );
      const stored = word.rows[0];
      const expected = fingerprintOutcome({
        kind: 'entry',
        displayText: stored.display_text,
        syllables: stored.syllables,
        definitionText: 'a made-up word',
        citedEntryId: null,
      });
      expect(decision.rows[0].value_fingerprint).toBe(expected);
    });

    it('still recomputes the split when accept_programmatic arrives WITHOUT a respell', async () => {
      // The guard must not disable the feature it defers to - accept_programmatic on its own is
      // still how a reviewer adopts the derived split.
      const wordId = `${NS}programmatic_alone`;
      await insertWord(wordId, 'kasu', ['ka', 'su', 'extra'], 'a word');

      await applyEntryDecision(
        pool,
        wordId,
        { action: 'keep_ours', syllableAction: 'accept_programmatic', definitionAction: 'confirm' },
        curatorUserId,
      );

      const word = await pool.query<{ syllables: string[] }>('select syllables from golden_record where word_id = $1', [
        wordId,
      ]);
      expect(word.rows[0].syllables).toEqual(['ka', 'su']);
    });
  });

  describe("respell: a spelling the reviewer wrote themselves", () => {
    // The common real case is a TONE correction, which is usually neither our
    // current spelling nor Kaikki's - so adopt_kaikki cannot express it (that action
    // re-verifies against Kaikki's suggestion) and keep_ours cannot either (it never
    // touches display_text).
    it('writes display_text and syllables together, with no Kaikki verification', async () => {
      const wordId = `${NS}respell_tone`;
      await insertWord(wordId, 'adiye', ['a', 'di', 'ye'], 'chicken');

      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'adìyẹ',
          newSyllables: ['a', 'dì', 'yẹ'],
          definitionAction: 'confirm',
        },
        curatorUserId,
      );

      const { rows } = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('adìyẹ');
      // Authored, not re-derived: re-syllabifying would discard the boundaries the
      // reviewer chose, which for a syllabic nasal changes the word.
      expect(rows[0].syllables).toEqual(['a', 'dì', 'yẹ']);
    });

    it('preserves a syllabic-nasal boundary that re-deriving would destroy', async () => {
      const wordId = `${NS}respell_nasal`;
      await insertWord(wordId, 'gbangba', ['gban', 'gba'], 'clearly');

      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'gban̄gba',
          newSyllables: ['gba', 'n̄', 'gba'],
          definitionAction: 'confirm',
        },
        curatorUserId,
      );

      const { rows } = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('gban̄gba');
      expect(rows[0].syllables).toEqual(['gba', 'n̄', 'gba']);
    });

    it('records the respelling in the decision so a settled word replays as settled', async () => {
      const wordId = `${NS}respell_replay`;
      await insertWord(wordId, 'adiye', ['a', 'di', 'ye'], 'chicken');
      await applyEntryDecision(
        pool,
        wordId,
        { action: 'respell', newDisplayText: 'adìyẹ', newSyllables: ['a', 'dì', 'yẹ'], definitionAction: 'confirm' },
        curatorUserId,
      );
      const { rows } = await readDecision(wordId);
      expect(rows[0].decision).toMatchObject({ action: 'respell', newDisplayText: 'adìyẹ' });
    });

    it('refuses a respelling whose syllables do not join to the spelling', async () => {
      // Production already contains one word whose display_text and syllables
      // disagree (agunfon_giraffe). Nothing should be able to create another.
      const wordId = `${NS}respell_mismatch`;
      await insertWord(wordId, 'adiye', ['a', 'di', 'ye'], 'chicken');
      await expect(
        applyEntryDecision(
          pool,
          wordId,
          { action: 'respell', newDisplayText: 'adìyẹ', newSyllables: ['a', 'dì', 'ye'], definitionAction: 'confirm' },
          curatorUserId,
        ),
      ).rejects.toThrow(RespellMismatchError);

      const { rows } = await pool.query<{ display_text: string }>(
        'select display_text from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('adiye');
    });

    it('accepts a PHRASE respelling, whose syllables carry no space', async () => {
      // The check compared the joined syllables against the whole spelling, so every phrase
      // failed it: `fi sílẹ̀` is three syllables, ['fi','sí','lẹ̀'], and joining them gives
      // `fisílẹ̀`. That is not a disagreement, it is a space - orthography rather than a
      // tone-bearing unit - and it is how createPhrase has always stored a phrase. Until
      // whitespace was stripped here, a phrase's spelling could not be corrected at all
      // once created, because this is the only endpoint that rewrites display_text.
      const wordId = `${NS}respell_phrase`;
      await insertWord(wordId, 'fi sile', ['fi', 'si', 'le'], 'to leave alone');
      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'fi sílẹ̀',
          newSyllables: ['fi', 'sí', 'lẹ̀'],
          definitionAction: 'confirm',
        },
        curatorUserId,
      );
      const { rows } = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('fi sílẹ̀');
      expect(rows[0].syllables).toEqual(['fi', 'sí', 'lẹ̀']);
    });

    it('still refuses a phrase whose syllables disagree with more than the spaces', async () => {
      // The check has to keep working through the whitespace exemption, or it stops being a
      // check: this differs in a vowel, not a space.
      const wordId = `${NS}respell_phrase_bad`;
      await insertWord(wordId, 'fi sile', ['fi', 'si', 'le'], 'to leave alone');
      await expect(
        applyEntryDecision(
          pool,
          wordId,
          {
            action: 'respell',
            newDisplayText: 'fi sílẹ̀',
            newSyllables: ['fi', 'sí', 'lò'],
            definitionAction: 'confirm',
          },
          curatorUserId,
        ),
      ).rejects.toThrow(RespellMismatchError);
    });

    it('accepts a HYPHENATED respelling, whose syllables carry no hyphen either', async () => {
      // Same rule as the space, and needed for the same reason: a hyphen is a separator between
      // tone-bearing units, not part of one. `ilé-ìwé` is four syllables and none contains the
      // hyphen. Wiktionary's Yoruba policy lemmatises the hyphenated form for an elongated nasal
      // (`aárùn-ún`), so refusing this would refuse the spelling we most need to record.
      const wordId = `${NS}respell_hyphen`;
      await insertWord(wordId, 'ile-iwe', ['i', 'le', 'i', 'we'], 'school');
      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'ilé-ìwé',
          newSyllables: ['i', 'lé', 'ì', 'wé'],
          definitionAction: 'confirm',
        },
        curatorUserId,
      );
      const { rows } = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('ilé-ìwé');
      expect(rows[0].syllables).toEqual(['i', 'lé', 'ì', 'wé']);
    });

    it('accepts a spelling carrying both a space and a hyphen', async () => {
      // 33 corpus headwords have both, so the separator rule cannot be either/or.
      const wordId = `${NS}respell_both`;
      await insertWord(wordId, 'ile-iwe giga', ['i', 'le', 'i', 'we', 'gi', 'ga'], 'high school');
      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'ilé-ìwé gíga',
          newSyllables: ['i', 'lé', 'ì', 'wé', 'gí', 'ga'],
          definitionAction: 'confirm',
        },
        curatorUserId,
      );
      const { rows } = await pool.query<{ display_text: string }>(
        'select display_text from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('ilé-ìwé gíga');
    });

    it('accepts a capitalised respelling, since the syllabifier lowercases', async () => {
      const wordId = `${NS}respell_proper`;
      await insertWord(wordId, 'agemo', ['a', 'ge', 'mo'], 'July');
      await applyEntryDecision(
        pool,
        wordId,
        { action: 'respell', newDisplayText: 'Agẹmọ', newSyllables: ['A', 'gẹ', 'mọ'], definitionAction: 'confirm' },
        curatorUserId,
      );
      const { rows } = await pool.query<{ display_text: string }>(
        'select display_text from golden_record where word_id = $1',
        [wordId],
      );
      expect(rows[0].display_text).toBe('Agẹmọ');
    });

    it('requires the syllables', async () => {
      const wordId = `${NS}respell_nosyl`;
      await insertWord(wordId, 'adiye', ['a', 'di', 'ye'], 'chicken');
      await expect(
        applyEntryDecision(
          pool,
          wordId,
          { action: 'respell', newDisplayText: 'adìyẹ', definitionAction: 'confirm' },
          curatorUserId,
        ),
      ).rejects.toThrow(RespellSyllablesRequiredError);
    });

    it('requires the spelling', async () => {
      const wordId = `${NS}respell_notext`;
      await insertWord(wordId, 'adiye', ['a', 'di', 'ye'], 'chicken');
      await expect(
        applyEntryDecision(
          pool,
          wordId,
          { action: 'respell', newSyllables: ['a', 'dì', 'yẹ'], definitionAction: 'confirm' },
          curatorUserId,
        ),
      ).rejects.toThrow(NewDisplayTextRequiredError);
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

    it('re-splits the word it is becoming, so the stored split cannot describe the old spelling', async () => {
      // Note: NO syllableAction. This branch used to write display_text and nothing else, leaving
      // the row holding the split of the word it used to be - the exact disagreement the respell
      // branch is careful never to create. It made the word permanently unrecordable-for-publish:
      // the publish comparison wants recorded_syllables to equal the stored split, while the audio
      // screen offers the split of the current spelling, and the two could never agree again.
      const wordId = `${NS}adopt_resplits`;
      await insertWord(wordId, 'kasu', ['ka', 'su']);

      await applyEntryDecision(
        pool,
        wordId,
        { action: 'adopt_kaikki', newDisplayText: 'kásù', definitionAction: 'confirm' },
        curatorUserId,
      );

      const word = await pool.query<{ display_text: string; syllables: string[] }>(
        'select display_text, syllables from golden_record where word_id = $1',
        [wordId],
      );
      expect(word.rows[0].display_text).toBe('kásù');
      expect(word.rows[0].syllables.join('')).toBe('kásù');
    });

    it('still lets an authored split win over the re-derived one', async () => {
      // The respell guard has to survive the change above: an authored split is a claim, and
      // re-deriving it is not. A decision carrying both must keep the human's.
      const wordId = `${NS}adopt_respell_wins`;
      await insertWord(wordId, 'kasu', ['ka', 'su']);

      await applyEntryDecision(
        pool,
        wordId,
        {
          action: 'respell',
          newDisplayText: 'kásù',
          newSyllables: ['kás', 'ù'],
          definitionAction: 'confirm',
        },
        curatorUserId,
      );

      const word = await pool.query<{ syllables: string[] }>('select syllables from golden_record where word_id = $1', [
        wordId,
      ]);
      expect(word.rows[0].syllables).toEqual(['kás', 'ù']);
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

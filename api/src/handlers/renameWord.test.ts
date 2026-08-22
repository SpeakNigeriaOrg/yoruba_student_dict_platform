import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOutcome } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { WordIdAlreadyExistsError, WordNotFoundError } from './errors.js';
import { InvalidWordIdError } from './wordIdShape.js';
import { renameWord, SameWordIdError } from './renameWord.js';

const NS = 'testrenw_';
const pool = getTestPool();
let userId: string;
let speakerId: string;

async function cleanUpSpeakers(): Promise<void> {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
}

beforeAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  const user = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, 'Test Curator', 'curator') returning user_id",
    [`${NS}curator@example.com`],
  );
  userId = user.rows[0].user_id;
  const speaker = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name) values ($1) returning speaker_id',
    [`${NS}speaker`],
  );
  speakerId = speaker.rows[0].speaker_id;
});

afterAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

beforeEach(async () => {
  await cleanUpTestData(pool, `${NS}w`);
});

async function insertWord(wordId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition, entry_type, pos, english_gloss, etymid_label)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      wordId,
      overrides.displayText ?? 'ọwọ́',
      overrides.syllables ?? ['ọ', 'wọ́'],
      overrides.definition ?? 'hand',
      overrides.entryType ?? null,
      overrides.pos ?? 'noun',
      overrides.englishGloss ?? 'hand',
      overrides.etymidLabel ?? 'hand',
    ],
  );
}

describe('renameWord input rules', () => {
  it('refuses an id that is not filename-, URL- and storage-key-safe', async () => {
    await insertWord(`${NS}wshape`);
    await expect(renameWord(pool, `${NS}wshape`, 'ọwọ́_hand', userId)).rejects.toThrow(InvalidWordIdError);
  });

  it('refuses renaming a word to the id it already has', async () => {
    await insertWord(`${NS}wsame`);
    await expect(renameWord(pool, `${NS}wsame`, `${NS}wsame`, userId)).rejects.toThrow(SameWordIdError);
  });

  it('refuses a word that does not exist', async () => {
    await expect(renameWord(pool, `${NS}wmissing`, `${NS}wmissing2`, userId)).rejects.toThrow(WordNotFoundError);
  });

  it('refuses a target id that is already taken', async () => {
    await insertWord(`${NS}wfrom`);
    await insertWord(`${NS}wtaken`);
    await expect(renameWord(pool, `${NS}wfrom`, `${NS}wtaken`, userId)).rejects.toThrow(WordIdAlreadyExistsError);
    // Both survive - the copy that step 1 would have made must not be left behind.
    const { rows } = await pool.query('select word_id from golden_record where word_id like $1', [`${NS}w%`]);
    expect(rows).toHaveLength(2);
  });
});

describe('renameWord', () => {
  it('carries every column of the entry across, not just the ones a rename thinks about', async () => {
    await insertWord(`${NS}wold`, { displayText: 'ilé-ìwé', syllables: ['i', 'lé', 'ì', 'wé'], entryType: 'phrase' });
    await renameWord(pool, `${NS}wold`, `${NS}wnew`, userId);

    const { rows } = await pool.query(
      `select display_text, syllables, definition, entry_type, pos, english_gloss, etymid_label, updated_by
         from golden_record where word_id = $1`,
      [`${NS}wnew`],
    );
    expect(rows[0]).toEqual({
      display_text: 'ilé-ìwé',
      syllables: ['i', 'lé', 'ì', 'wé'],
      definition: 'hand',
      entry_type: 'phrase',
      pos: 'noun',
      english_gloss: 'hand',
      etymid_label: 'hand',
      updated_by: userId,
    });
    const old = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}wold`]);
    expect(old.rowCount).toBe(0);
  });

  it('moves every attached row instead of letting the old id take them with it', async () => {
    const from = `${NS}wattached`;
    const to = `${NS}wattached2`;
    await insertWord(from);
    const utterance = await pool.query<{ utterance_id: string }>(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'utterances/x.wav', 'ọwọ́', $3) returning utterance_id`,
      [from, speakerId, ['ọ', 'wọ́']],
    );
    await pool.query(
      `insert into syllable_observations
         (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive,
          syllable_orthography_insensitive, legacy_syllable_key, start_time_s, end_time_s, blob_path)
       values ($1, 0, 'wọ́', 'wọ', 'wo', 'wo', 0, 0.4, 'syllables/x.wav')`,
      [utterance.rows[0].utterance_id],
    );
    await pool.query(
      `insert into canonical_utterance_selections (word_id, speaker_id, utterance_id, selected_by)
       values ($1, $2, $3, $4)`,
      [from, speakerId, utterance.rows[0].utterance_id, userId],
    );
    await pool.query(`insert into word_images (word_id, art_style, image_data, blob_path) values ($1, 'cartoon', $2, 'i.png')`, [
      from,
      Buffer.from('png'),
    ]);
    await pool.query(`insert into canonical_image_selections (word_id, art_style, image_id, selected_by)
       select $1, 'cartoon', image_id, $2 from word_images where word_id = $1`, [from, userId]);
    await pool.query(
      `insert into word_examples (word_id, submitted_by, example_type, example_text, translation, audio_data, recorded_word_text)
       values ($1, $2, 'usage_phrase', 'mo ní ọwọ́', 'I have a hand', $3, 'ọwọ́')`,
      [from, userId, Buffer.from('wav')],
    );
    await pool.query(`insert into upstream_citations (word_id, exempt_reason, pin) values ($1, 'test word', '{}'::jsonb)`, [from]);
    await pool.query(`insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', '{}'::jsonb, $2)`, [
      from,
      userId,
    ]);
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, submitted_by) values ($1, 'entry', '{}'::jsonb, $2)`,
      [from, userId],
    );
    await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [from, userId]);
    await pool.query(
      `insert into word_decisions_premerge (word_id, axis, decision, decided_by, decided_at)
       values ($1, 'spelling', '{}'::jsonb, $2, now())`,
      [from, userId],
    );

    const result = await renameWord(pool, from, to, userId);
    expect(Object.fromEntries(result.moved.map((m) => [m.label, m.count]))).toEqual({
      'audio recordings': 1,
      images: 1,
      'example sentences': 1,
      'contributions (proposals, votes, evidence)': 1,
      'review decisions': 1,
      'upstream etymology citation': 1,
      'review assignments': 1,
      'canonical recording picks': 1,
      'canonical image picks': 1,
      'archived pre-merge decisions': 1,
    });

    for (const table of [
      'utterances',
      'word_images',
      'word_examples',
      'contributions',
      'word_decisions',
      'upstream_citations',
      'assignments',
      'canonical_utterance_selections',
      'canonical_image_selections',
      'word_decisions_premerge',
    ]) {
      const moved = await pool.query(`select 1 from ${table} where word_id = $1`, [to]);
      const left = await pool.query(`select 1 from ${table} where word_id = $1`, [from]);
      expect(`${table}: ${moved.rowCount} moved, ${left.rowCount} left`).toBe(`${table}: 1 moved, 0 left`);
    }
    // The clip hangs off the utterance, so it survives by the utterance surviving - which is the
    // whole point of renaming rather than deleting and re-adding.
    const clips = await pool.query('select 1 from syllable_observations where utterance_id = $1', [
      utterance.rows[0].utterance_id,
    ]);
    expect(clips.rowCount).toBe(1);
  });

  it('moves the word on both sides of the component index', async () => {
    const from = `${NS}wcomp`;
    const to = `${NS}wcomp2`;
    await insertWord(from);
    await insertWord(`${NS}wparent`);
    await insertWord(`${NS}wchild`);
    await pool.query('insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)', [
      `${NS}wparent`,
      from,
    ]);
    await pool.query('insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)', [
      from,
      `${NS}wchild`,
    ]);

    await renameWord(pool, from, to, userId);

    const asComponent = await pool.query('select word_id from golden_record_components where component_word_id = $1', [to]);
    expect(asComponent.rows).toEqual([{ word_id: `${NS}wparent` }]);
    const ownParts = await pool.query('select component_word_id from golden_record_components where word_id = $1', [to]);
    expect(ownParts.rows).toEqual([{ component_word_id: `${NS}wchild` }]);
  });

  it("rewrites the old id where it sits inside another entry's stored decision", async () => {
    const from = `${NS}wjson`;
    const to = `${NS}wjson2`;
    await insertWord(from);
    await insertWord(`${NS}wholder`);
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, decided_by)
       values ($1, 'etymology', $2, $3)`,
      [`${NS}wholder`, { componentsAction: 'custom', components: [from, `${NS}wother`] }, userId],
    );
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, resolved_value, submitted_by)
       values ($1, 'etymology', $2, $3, $4)`,
      [
        `${NS}wholder`,
        { componentsAction: 'custom', components: [from] },
        { kind: 'etymology', components: [from], atomic: false },
        userId,
      ],
    );

    const result = await renameWord(pool, from, to, userId);
    expect(result.componentReferencesRewritten).toBe(3);

    const decision = await pool.query<{ decision: { components: string[] } }>(
      "select decision from word_decisions where word_id = $1 and axis = 'etymology'",
      [`${NS}wholder`],
    );
    expect(decision.rows[0].decision.components).toEqual([to, `${NS}wother`]);
    const contribution = await pool.query<{ proposed_value: { components: string[] }; resolved_value: { components: string[] } }>(
      'select proposed_value, resolved_value from contributions where word_id = $1',
      [`${NS}wholder`],
    );
    expect(contribution.rows[0].proposed_value.components).toEqual([to]);
    expect(contribution.rows[0].resolved_value.components).toEqual([to]);
  });

  it('re-expresses consensus fingerprints in the new id, so agreement across the rename still reads as agreement', async () => {
    const from = `${NS}wfp`;
    const to = `${NS}wfp2`;
    await insertWord(from);
    await insertWord(`${NS}wfpholder`);
    const before = fingerprintOutcome({ kind: 'etymology', components: [from, `${NS}wsibling`], atomic: false });
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, submitted_by)
       values ($1, 'etymology', '{}'::jsonb, $2, $3, $4)`,
      [`${NS}wfpholder`, { kind: 'etymology', components: [from, `${NS}wsibling`], atomic: false }, before, userId],
    );
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, value_fingerprint, decided_by)
       values ($1, 'etymology', '{}'::jsonb, $2, $3)`,
      [`${NS}wfpholder`, before, userId],
    );

    const result = await renameWord(pool, from, to, userId);
    expect(result.fingerprintsRewritten).toBe(2);

    // The bar is not "it changed" but "it equals what the same belief would fingerprint to if
    // submitted fresh after the rename" - that equality is the entire purpose.
    const after = fingerprintOutcome({ kind: 'etymology', components: [to, `${NS}wsibling`], atomic: false });
    const contribution = await pool.query<{ value_fingerprint: string }>(
      'select value_fingerprint from contributions where word_id = $1',
      [`${NS}wfpholder`],
    );
    const decision = await pool.query<{ value_fingerprint: string }>(
      "select value_fingerprint from word_decisions where word_id = $1 and axis = 'etymology'",
      [`${NS}wfpholder`],
    );
    expect(contribution.rows[0].value_fingerprint).toBe(after);
    expect(decision.rows[0].value_fingerprint).toBe(after);
  });

  it('leaves an entry fingerprint alone - it names no components', async () => {
    const from = `${NS}wentryfp`;
    await insertWord(from);
    const entryPrint = fingerprintOutcome({
      kind: 'entry',
      displayText: 'ọwọ́',
      syllables: ['ọ', 'wọ́'],
      definitionText: 'hand',
      citedEntryId: null,
    });
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, value_fingerprint, decided_by)
       values ($1, 'entry', '{}'::jsonb, $2, $3)`,
      [from, entryPrint, userId],
    );

    const result = await renameWord(pool, from, `${NS}wentryfp2`, userId);
    expect(result.fingerprintsRewritten).toBe(0);
    const { rows } = await pool.query<{ value_fingerprint: string }>(
      "select value_fingerprint from word_decisions where word_id = $1 and axis = 'entry'",
      [`${NS}wentryfp2`],
    );
    expect(rows[0].value_fingerprint).toBe(entryPrint);
  });
});

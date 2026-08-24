import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { WordNotFoundError } from './errors.js';
import { loadWordDossier } from './wordDossier.js';

const NS = 'testdossier_';
const WORD = `${NS}word`;
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
    "insert into users (email, display_name, role) values ($1, 'Dossier Curator', 'curator') returning user_id",
    [`${NS}curator@example.com`],
  );
  userId = user.rows[0].user_id;
  const speaker = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name) values ($1) returning speaker_id',
    [`${NS}speaker`],
  );
  speakerId = speaker.rows[0].speaker_id;

  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition, pos, english_gloss)
     values ($1, 'ọwọ́', array['ọ','wọ́'], 'hand', 'noun', 'hand')`,
    [WORD],
  );
  await pool.query(
    `insert into upstream_citations (word_id, entry_id, pin, pinned_by)
     values ($1, 'en-owo-yo-noun', $2, $3)`,
    [WORD, { pos: 'noun', glosses: ['hand'], canonicalForm: 'ọwọ́' }, userId],
  );
  await pool.query("insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', '{}', $2)", [
    WORD,
    userId,
  ]);
  await pool.query(
    `insert into word_decisions_premerge (word_id, axis, decision, decided_by, decided_at)
     values ($1, 'spelling', '{}'::jsonb, $2, now())`,
    [WORD, userId],
  );
  // One active and one superseded - the belief history 0013 preserved and nothing could read.
  await pool.query(
    `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, submitted_by, status)
     values ($1, 'entry', '{}'::jsonb, '{}'::jsonb, 'fp-old', $2, 'superseded')`,
    [WORD, userId],
  );
  await pool.query(
    `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, submitted_by)
     values ($1, 'entry', '{}'::jsonb, '{}'::jsonb, 'fp-new', $2)`,
    [WORD, userId],
  );
  const utterance = await pool.query<{ utterance_id: string }>(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables, audio_data)
     values ($1, $2, 1, 'x', 'ọwọ́', array['ọ','wọ́'], $3) returning utterance_id`,
    [WORD, speakerId, Buffer.from('wav')],
  );
  await pool.query(
    `insert into syllable_observations
       (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive,
        syllable_orthography_insensitive, legacy_syllable_key, start_time_s, end_time_s, blob_path, vad_confidence)
     values ($1, 0, 'ọ', 'ọ', 'o', 'o', 0, 0.2, 'x', 0.42)`,
    [utterance.rows[0].utterance_id],
  );
  await pool.query(
    `insert into word_examples (word_id, submitted_by, example_type, example_text, translation, audio_data, recorded_word_text)
     values ($1, $2, 'usage_phrase', 'mo ní ọwọ́', 'I have a hand', $3, 'ọwọ-old')`,
    [WORD, userId, Buffer.from('wav')],
  );
  await pool.query(
    "insert into word_images (word_id, art_style, image_data, blob_path) values ($1, 'cartoon', $2, 'i.png')",
    [WORD, Buffer.from('pngbytes')],
  );
  await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [WORD, userId]);
});

afterAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('loadWordDossier', () => {
  it('refuses a word that does not exist', async () => {
    await expect(loadWordDossier(pool, `${NS}nope`)).rejects.toThrow(WordNotFoundError);
  });

  it('returns the pin itself, not just a drift verdict about it', async () => {
    // 0014 stores what upstream said when a human validated the citation. Until now it
    // surfaced only as a diff, so the copy the entry axis reasons from was uninspectable.
    const d = await loadWordDossier(pool, WORD);
    expect(d.citation).toBe('cited');
    expect(d.citedEntryId).toBe('en-owo-yo-noun');
    expect(d.pin).toMatchObject({ pos: 'noun', glosses: ['hand'] });
    expect(d.pinnedByEmail).toBe(`${NS}curator@example.com`);
  });

  it('includes superseded contributions, which every other query filters out', async () => {
    const d = await loadWordDossier(pool, WORD);
    expect(d.contributions.map((c) => c.status).sort()).toEqual(['active', 'superseded']);
  });

  it("includes 0011's archived decisions, marked as archived", async () => {
    const d = await loadWordDossier(pool, WORD);
    const archived = d.decisions.filter((x) => x.archived);
    expect(archived).toHaveLength(1);
    expect(archived[0].axis).toBe('spelling');
    expect(d.decisions.filter((x) => !x.archived).map((x) => x.axis)).toEqual(['entry']);
  });

  it('reports each recording against the word as it now stands, with its segment confidence', async () => {
    const d = await loadWordDossier(pool, WORD);
    expect(d.recordings).toHaveLength(1);
    expect(d.recordings[0]).toMatchObject({
      speakerName: `${NS}speaker`,
      matchesGolden: true,
      segmentCount: 1,
      lowestSegmentConfidence: 0.42,
      releaseState: 'unknown',
    });
  });

  it('flags an example recorded under a spelling the word no longer has', async () => {
    const d = await loadWordDossier(pool, WORD);
    expect(d.examples[0].wordTextChanged).toBe(true);
    expect(d.examples[0].recordedWordText).toBe('ọwọ-old');
  });

  it('lists images as metadata, not bytes', async () => {
    const d = await loadWordDossier(pool, WORD);
    expect(d.images).toHaveLength(1);
    expect(d.images[0].byteLength).toBe(8);
    expect(d.images[0]).not.toHaveProperty('imageData');
  });

  it('carries the publication overrides and the assignment', async () => {
    const d = await loadWordDossier(pool, WORD);
    expect(d.pos).toBe('noun');
    expect(d.englishGloss).toBe('hand');
    expect(d.assignees.map((a) => a.email)).toEqual([`${NS}curator@example.com`]);
  });
});

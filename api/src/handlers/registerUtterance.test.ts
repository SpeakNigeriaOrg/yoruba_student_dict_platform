import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { registerUtterance } from './registerUtterance.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testregutt_';
const pool = getTestPool();
let userId: string;
const username = `${NS}user`;

// Cleans every speaker/utterance this namespace could ever have created -
// scoped by the speakers.display_name pattern (not a single userId), so a
// prior interrupted run's orphaned rows never block this one. Real FK
// chain, unwound in the only order that doesn't violate a constraint:
// utterances (references speakers) -> speakers (references users) ->
// cleanUpTestData's own golden_record/users cleanup, which would
// otherwise hit "speakers still references this user".
async function cleanUpSpeakers(): Promise<void> {
  await pool.query(
    "delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)",
    [`${NS}%`],
  );
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
}

beforeAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [username, 'Test User'],
  );
  userId = result.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string, syllables: string[]): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    syllables.join(''),
    syllables,
  ]);
}

const FAKE_AUDIO = Buffer.from('fake wav bytes');

describe('registerUtterance', () => {
  it('registers a whole-word take with no segments, storing its audio bytes, recorded pronunciation, and a logical blob_path', async () => {
    const wordId = `${NS}word_one`;
    await insertWord(wordId, ['kà', 'sù']);

    const result = await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 1,
        audioData: FAKE_AUDIO,
        recordedDisplayText: 'kàsù',
        recordedSyllables: ['kà', 'sù'],
        durationS: 1.2,
        sampleRate: 48000,
      },
      userId,
      username,
    );

    expect(result.utteranceId).toBeDefined();
    const speaker = await pool.query<{ speaker_id: string }>('select speaker_id from speakers where user_id = $1', [userId]);
    expect(speaker.rowCount).toBe(1);

    const row = await pool.query<{
      status: string;
      blob_path: string;
      raw_blob_path: string;
      audio_data: Buffer;
      raw_audio_data: Buffer;
      recorded_display_text: string;
      recorded_syllables: string[];
    }>(
      'select status, blob_path, raw_blob_path, audio_data, raw_audio_data, recorded_display_text, recorded_syllables from utterances where utterance_id = $1',
      [result.utteranceId],
    );
    expect(row.rows[0].status).toBe('pending_processing');
    expect(row.rows[0].blob_path).toBe(`utterances/${wordId}/${speaker.rows[0].speaker_id}/take1.wav`);
    expect(Buffer.compare(row.rows[0].audio_data, FAKE_AUDIO)).toBe(0);
    expect(row.rows[0].recorded_display_text).toBe('kàsù');
    expect(row.rows[0].recorded_syllables).toEqual(['kà', 'sù']);
    // No distinct raw bytes supplied - defaults to the same content/path
    // as the processed version (see file header).
    expect(row.rows[0].raw_blob_path).toBe(`utterances/${wordId}/${speaker.rows[0].speaker_id}/take1-raw.wav`);
    expect(Buffer.compare(row.rows[0].raw_audio_data, FAKE_AUDIO)).toBe(0);
  });

  it('stores a distinct raw recording when one is supplied separately from the processed audio', async () => {
    const wordId = `${NS}word_raw`;
    await insertWord(wordId, ['ta']);

    const result = await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 1,
        audioData: Buffer.from('processed-bytes'),
        rawAudioData: Buffer.from('raw-bytes'),
        recordedDisplayText: 'ta',
        recordedSyllables: ['ta'],
      },
      userId,
      username,
    );

    const row = await pool.query<{ audio_data: Buffer; raw_audio_data: Buffer }>(
      'select audio_data, raw_audio_data from utterances where utterance_id = $1',
      [result.utteranceId],
    );
    expect(Buffer.compare(row.rows[0].audio_data, Buffer.from('processed-bytes'))).toBe(0);
    expect(Buffer.compare(row.rows[0].raw_audio_data, Buffer.from('raw-bytes'))).toBe(0);
  });

  it('reuses the same speaker on a second registration from the same user', async () => {
    const wordId = `${NS}word_two`;
    await insertWord(wordId, ['bá']);
    await registerUtterance(
      pool,
      { wordId, takeNumber: 1, audioData: FAKE_AUDIO, recordedDisplayText: 'bá', recordedSyllables: ['bá'] },
      userId,
      username,
    );
    await registerUtterance(
      pool,
      { wordId, takeNumber: 1, audioData: FAKE_AUDIO, recordedDisplayText: 'bá', recordedSyllables: ['bá'] },
      userId,
      username,
    );

    const speakers = await pool.query('select speaker_id from speakers where user_id = $1', [userId]);
    expect(speakers.rowCount).toBe(1);
  });

  it('registers segments, deriving syllable_text/tone_insensitive/orthography_insensitive from the recorded (not golden_record) syllables', async () => {
    const wordId = `${NS}word_three`;
    // golden_record's current syllabification differs from what this
    // speaker actually recorded - a real, expected case (recorded before
    // a later spelling decision converged on something else), and exactly
    // what recordedSyllables exists to capture faithfully.
    await insertWord(wordId, ['kà', 'sún']);

    const result = await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 2,
        audioData: FAKE_AUDIO,
        recordedDisplayText: 'kàsù',
        recordedSyllables: ['kà', 'sù'],
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.3, confidence: 0.9, audioData: Buffer.from('seg0') },
          { syllablePosition: 1, startTimeS: 0.5, endTimeS: 0.8, confidence: 0.85, audioData: Buffer.from('seg1') },
        ],
      },
      userId,
      username,
    );

    const utterance = await pool.query<{ status: string }>('select status from utterances where utterance_id = $1', [
      result.utteranceId,
    ]);
    expect(utterance.rows[0].status).toBe('segmented');

    const observations = await pool.query<{
      syllable_position: number;
      syllable_text: string;
      syllable_tone_insensitive: string;
      syllable_orthography_insensitive: string;
      blob_path: string;
      audio_data: Buffer;
      raw_audio_data: Buffer;
    }>(
      'select syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive, blob_path, audio_data, raw_audio_data from syllable_observations where utterance_id = $1 order by syllable_position',
      [result.utteranceId],
    );
    expect(observations.rows).toHaveLength(2);
    expect(observations.rows[0].syllable_position).toBe(0);
    expect(observations.rows[0].syllable_text).toBe('kà');
    expect(Buffer.compare(observations.rows[0].audio_data, Buffer.from('seg0'))).toBe(0);
    // No distinct raw clip supplied - defaults to the same bytes as the processed segment.
    expect(Buffer.compare(observations.rows[0].raw_audio_data, Buffer.from('seg0'))).toBe(0);
    // 'sù', not golden_record's current 'sún' - the recorded pronunciation wins.
    expect(observations.rows[1].syllable_text).toBe('sù');
  });

  it('replaces prior segments wholesale when the same take is re-registered', async () => {
    const wordId = `${NS}word_four`;
    await insertWord(wordId, ['ta', 'ba', 'sa']);

    const first = await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 2,
        audioData: FAKE_AUDIO,
        recordedDisplayText: 'tabasa',
        recordedSyllables: ['ta', 'ba', 'sa'],
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.1, confidence: 0.9, audioData: Buffer.from('seg0') },
          { syllablePosition: 1, startTimeS: 0.2, endTimeS: 0.3, confidence: 0.9, audioData: Buffer.from('seg1') },
          { syllablePosition: 2, startTimeS: 0.4, endTimeS: 0.5, confidence: 0.9, audioData: Buffer.from('seg2') },
        ],
      },
      userId,
      username,
    );

    const second = await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 2,
        audioData: FAKE_AUDIO,
        recordedDisplayText: 'tabasa',
        recordedSyllables: ['ta', 'ba', 'sa'],
        segments: [{ syllablePosition: 0, startTimeS: 0, endTimeS: 0.1, confidence: 0.9, audioData: Buffer.from('reseg0') }],
      },
      userId,
      username,
    );

    expect(second.utteranceId).toBe(first.utteranceId); // re-registering the same (word,speaker,take) upserts, not duplicates
    const observations = await pool.query<{ audio_data: Buffer }>(
      'select audio_data from syllable_observations where utterance_id = $1',
      [second.utteranceId],
    );
    expect(observations.rows).toHaveLength(1);
    expect(Buffer.compare(observations.rows[0].audio_data, Buffer.from('reseg0'))).toBe(0);
  });

  it('rejects a segment whose syllablePosition is out of range for the recorded syllables', async () => {
    const wordId = `${NS}word_five`;
    await insertWord(wordId, ['lo']);

    await expect(
      registerUtterance(
        pool,
        {
          wordId,
          takeNumber: 2,
          audioData: FAKE_AUDIO,
          recordedDisplayText: 'lo',
          recordedSyllables: ['lo'],
          segments: [{ syllablePosition: 5, startTimeS: 0, endTimeS: 0.1, confidence: 0.9, audioData: Buffer.from('seg') }],
        },
        userId,
        username,
      ),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      registerUtterance(
        pool,
        {
          wordId: `${NS}nonexistent`,
          takeNumber: 1,
          audioData: FAKE_AUDIO,
          recordedDisplayText: 'x',
          recordedSyllables: ['x'],
        },
        userId,
        username,
      ),
    ).rejects.toThrow(WordNotFoundError);
  });
});

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

describe('registerUtterance', () => {
  it('registers a whole-word take with no segments, creating a speaker for a first-time user', async () => {
    const wordId = `${NS}word_one`;
    await insertWord(wordId, ['kà', 'sù']);

    const result = await registerUtterance(
      pool,
      { wordId, takeNumber: 1, blobPath: `utterances/${wordId}/take1.wav`, durationS: 1.2, sampleRate: 48000 },
      userId,
      username,
    );

    expect(result.utteranceId).toBeDefined();
    const row = await pool.query<{ status: string; blob_path: string }>(
      'select status, blob_path from utterances where utterance_id = $1',
      [result.utteranceId],
    );
    expect(row.rows[0].status).toBe('pending_processing');
    expect(row.rows[0].blob_path).toBe(`utterances/${wordId}/take1.wav`);

    const speaker = await pool.query('select speaker_id from speakers where user_id = $1', [userId]);
    expect(speaker.rowCount).toBe(1);
  });

  it('reuses the same speaker on a second registration from the same user', async () => {
    const wordId = `${NS}word_two`;
    await insertWord(wordId, ['bá']);
    await registerUtterance(pool, { wordId, takeNumber: 1, blobPath: 'x' }, userId, username);
    await registerUtterance(pool, { wordId, takeNumber: 1, blobPath: 'y' }, userId, username);

    const speakers = await pool.query('select speaker_id from speakers where user_id = $1', [userId]);
    expect(speakers.rowCount).toBe(1);
  });

  it('registers segments, deriving syllable_text/tone_insensitive/orthography_insensitive from golden_record.syllables', async () => {
    const wordId = `${NS}word_three`;
    await insertWord(wordId, ['kà', 'sù']);

    const result = await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 2,
        blobPath: `utterances/${wordId}/take2.wav`,
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.3, confidence: 0.9, blobPath: `syllables/${wordId}/0.wav` },
          { syllablePosition: 1, startTimeS: 0.5, endTimeS: 0.8, confidence: 0.85, blobPath: `syllables/${wordId}/1.wav` },
        ],
      },
      userId,
      username,
    );

    const utterance = await pool.query<{ status: string }>('select status from utterances where utterance_id = $1', [
      result.utteranceId,
    ]);
    expect(utterance.rows[0].status).toBe('segmented');

    const observations = await pool.query(
      'select syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive, blob_path from syllable_observations where utterance_id = $1 order by syllable_position',
      [result.utteranceId],
    );
    expect(observations.rows).toHaveLength(2);
    expect(observations.rows[0]).toMatchObject({
      syllable_position: 0,
      syllable_text: 'kà',
      blob_path: `syllables/${wordId}/0.wav`,
    });
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
        blobPath: 'a',
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.1, confidence: 0.9, blobPath: 'seg0' },
          { syllablePosition: 1, startTimeS: 0.2, endTimeS: 0.3, confidence: 0.9, blobPath: 'seg1' },
          { syllablePosition: 2, startTimeS: 0.4, endTimeS: 0.5, confidence: 0.9, blobPath: 'seg2' },
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
        blobPath: 'b',
        segments: [{ syllablePosition: 0, startTimeS: 0, endTimeS: 0.1, confidence: 0.9, blobPath: 'reseg0' }],
      },
      userId,
      username,
    );

    expect(second.utteranceId).toBe(first.utteranceId); // re-registering the same (word,speaker,take) upserts, not duplicates
    const observations = await pool.query('select blob_path from syllable_observations where utterance_id = $1', [
      second.utteranceId,
    ]);
    expect(observations.rows).toEqual([{ blob_path: 'reseg0' }]);
  });

  it('rejects a segment whose syllablePosition is out of range for the word', async () => {
    const wordId = `${NS}word_five`;
    await insertWord(wordId, ['lo']);

    await expect(
      registerUtterance(
        pool,
        {
          wordId,
          takeNumber: 2,
          blobPath: 'x',
          segments: [{ syllablePosition: 5, startTimeS: 0, endTimeS: 0.1, confidence: 0.9, blobPath: 'seg' }],
        },
        userId,
        username,
      ),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(
      registerUtterance(pool, { wordId: `${NS}nonexistent`, takeNumber: 1, blobPath: 'x' }, userId, username),
    ).rejects.toThrow(WordNotFoundError);
  });
});

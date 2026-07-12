import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { registerUtterance } from './registerUtterance.js';
import { listUtterances } from './listUtterances.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testlistutt_';
const pool = getTestPool();
let userId: string;
const username = `${NS}user`;

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

describe('listUtterances', () => {
  it('lists both takes (with segments on take 2) for a word, across speakers, with audio inlined as base64', async () => {
    const wordId = `${NS}word_one`;
    await insertWord(wordId, ['kà', 'sù']);

    await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 1,
        audioData: Buffer.from('take1-bytes'),
        recordedDisplayText: 'kàsù',
        recordedSyllables: ['kà', 'sù'],
        durationS: 1.1,
        sampleRate: 16000,
      },
      userId,
      username,
    );
    await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 2,
        audioData: Buffer.from('take2-bytes'),
        recordedDisplayText: 'kàsù',
        recordedSyllables: ['kà', 'sù'],
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.3, confidence: 0.9, audioData: Buffer.from('seg0') },
          { syllablePosition: 1, startTimeS: 0.5, endTimeS: 0.8, confidence: 0.8, audioData: Buffer.from('seg1') },
        ],
      },
      userId,
      username,
    );

    const result = await listUtterances(pool, wordId, userId);
    expect(result).toHaveLength(2);

    const take1 = result.find((u) => u.takeNumber === 1)!;
    expect(take1.status).toBe('pending_processing');
    expect(take1.isOwnRecording).toBe(true);
    expect(take1.recordedDisplayText).toBe('kàsù');
    expect(take1.audioDataBase64).toBe(Buffer.from('take1-bytes').toString('base64'));
    // No distinct raw audio supplied - defaults to the processed bytes.
    expect(take1.rawAudioDataBase64).toBe(Buffer.from('take1-bytes').toString('base64'));
    expect(take1.segments).toEqual([]);

    const take2 = result.find((u) => u.takeNumber === 2)!;
    expect(take2.status).toBe('segmented');
    expect(take2.segments).toHaveLength(2);
    expect(take2.segments[0]).toMatchObject({ syllablePosition: 0, syllableText: 'kà' });
    expect(take2.segments[0].audioDataBase64).toBe(Buffer.from('seg0').toString('base64'));
    expect(take2.segments[0].rawAudioDataBase64).toBe(Buffer.from('seg0').toString('base64'));

    // Both takes came from the same (test) speaker.
    expect(take1.speakerId).toBe(take2.speakerId);
    expect(take1.speakerDisplayName).toBe(username);
  });

  it("flags a different user's recording as isOwnRecording: false, and the requester's own as true, in the same result", async () => {
    const wordId = `${NS}word_three`;
    await insertWord(wordId, ['bí']);

    const otherUsername = `${NS}other_user`;
    const otherUser = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
      [otherUsername, 'Other Test User'],
    );

    await registerUtterance(
      pool,
      { wordId, takeNumber: 1, audioData: Buffer.from('mine'), recordedDisplayText: 'bí', recordedSyllables: ['bí'] },
      userId,
      username,
    );
    await registerUtterance(
      pool,
      { wordId, takeNumber: 1, audioData: Buffer.from('theirs'), recordedDisplayText: 'bí', recordedSyllables: ['bí'] },
      otherUser.rows[0].user_id,
      otherUsername,
    );

    const result = await listUtterances(pool, wordId, userId);
    expect(result).toHaveLength(2);
    const mine = result.find((u) => u.speakerDisplayName === username)!;
    const theirs = result.find((u) => u.speakerDisplayName === otherUsername)!;
    expect(mine.isOwnRecording).toBe(true);
    expect(theirs.isOwnRecording).toBe(false);
  });

  it('returns an empty list for a word with no recordings yet', async () => {
    const wordId = `${NS}word_two`;
    await insertWord(wordId, ['bá']);

    const result = await listUtterances(pool, wordId, userId);
    expect(result).toEqual([]);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(listUtterances(pool, `${NS}nonexistent`, userId)).rejects.toThrow(WordNotFoundError);
  });
});

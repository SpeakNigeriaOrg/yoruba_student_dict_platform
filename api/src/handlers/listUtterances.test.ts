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
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
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
      "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
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

    // The curator view: every speaker, flagged so the UI can keep them apart.
    const result = await listUtterances(pool, wordId, userId, { includeOtherSpeakers: true });
    expect(result).toHaveLength(2);
    const mine = result.find((u) => u.speakerDisplayName === username)!;
    const theirs = result.find((u) => u.speakerDisplayName === otherUsername)!;
    expect(mine.isOwnRecording).toBe(true);
    expect(theirs.isOwnRecording).toBe(false);

    // And the volunteer view of the same word: their own recording, and nothing else. Asserted
    // at this layer because that is where it is enforced - hiding the section in the UI while
    // still shipping the audio and the speaker names to the browser would make "volunteers do
    // not see other contributors" true only of the DOM.
    const scoped = await listUtterances(pool, wordId, userId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].speakerDisplayName).toBe(username);
    expect(scoped[0].isOwnRecording).toBe(true);
  });

  it('defaults to the caller\'s own recordings, so a new caller under-shares rather than over-shares', async () => {
    const wordId = `${NS}word_default_scope`;
    await insertWord(wordId, ['dà']);
    const strangerName = `${NS}stranger`;
    const stranger = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
      [strangerName, 'Stranger'],
    );
    await registerUtterance(
      pool,
      { wordId, takeNumber: 1, audioData: Buffer.from('theirs'), recordedDisplayText: 'dà', recordedSyllables: ['dà'] },
      stranger.rows[0].user_id,
      strangerName,
    );

    // The requester has recorded nothing here, so scoping correctly yields nothing at all -
    // rather than someone else's voice.
    expect(await listUtterances(pool, wordId, userId)).toEqual([]);
    expect(await listUtterances(pool, wordId, userId, { includeOtherSpeakers: true })).toHaveLength(1);
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

  describe('divergesFromGolden', () => {
    // Mirrors the publish step's own gate: publishToR2.mjs and
    // exportGameContent.mjs both require recorded_display_text = display_text
    // AND recorded_syllables = syllables, and silently drop anything else.
    // Flagging it here is what turns that silent drop into something the
    // speaker can act on.
    async function recordUnder(wordId: string, displayText: string, syllables: string[]) {
      await registerUtterance(
        pool,
        { wordId, takeNumber: 1, audio: 'AAAA', recordedDisplayText: displayText, recordedSyllables: syllables },
        userId,
        username,
      );
    }

    it('is false when the recording still matches the record', async () => {
      const wordId = `${NS}match_word`;
      await insertWord(wordId, ['kà', 'sù']);
      await recordUnder(wordId, 'kàsù', ['kà', 'sù']);

      const [utterance] = await listUtterances(pool, wordId, userId);
      expect(utterance.divergesFromGolden).toBe(false);
    });

    it('is true once the spelling changes under it', async () => {
      const wordId = `${NS}respelled_word`;
      await insertWord(wordId, ['ka', 'su']);
      await recordUnder(wordId, 'kasu', ['ka', 'su']);

      // A curator later decides the word is really 'kásù'.
      await pool.query('update golden_record set display_text = $1, syllables = $2 where word_id = $3', [
        'kásù',
        ['ká', 'sù'],
        wordId,
      ]);

      const [utterance] = await listUtterances(pool, wordId, userId);
      expect(utterance.divergesFromGolden).toBe(true);
      // The recording still says what the speaker actually said - the point of
      // preserving the pronunciation separately.
      expect(utterance.recordedDisplayText).toBe('kasu');
      expect(utterance.recordedSyllables).toEqual(['ka', 'su']);
    });

    it('is true when only the syllable split changed', async () => {
      const wordId = `${NS}resplit_word`;
      await insertWord(wordId, ['ka', 'su']);
      await recordUnder(wordId, 'kasu', ['ka', 'su']);

      await pool.query('update golden_record set syllables = $1 where word_id = $2', [['k', 'a', 'su'], wordId]);

      const [utterance] = await listUtterances(pool, wordId, userId);
      expect(utterance.divergesFromGolden).toBe(true);
    });
  });
});

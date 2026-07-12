import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { registerUtterance } from './registerUtterance.js';
import { listSyllableObservations } from './listSyllableObservations.js';

const NS = 'testlistsyll_';
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

describe('listSyllableObservations', () => {
  // Synthetic, NS-prefixed syllable spellings throughout this file -
  // NOT real Yoruba syllables like plain "kò" - this project's own real
  // migrated production data (migrateLegacyAudio.mjs's speaker3
  // recordings) genuinely contains common real syllables, so a real-
  // looking syllable here would silently pick up unrelated real rows
  // from a query that is deliberately global/unscoped by design (that's
  // the whole point of this handler) rather than being namespaced like
  // every word_id/username elsewhere in this test.
  const targetSyllable = `${NS}kò`;
  const differentToneSyllable = `${NS}ko`;

  it('finds every recording of one exact tone-marked syllable, across different words, each carrying its own origin', async () => {
    const wordA = `${NS}word_a`;
    const wordB = `${NS}word_b`;
    // targetSyllable appears in wordA at position 1 (repeated syllable
    // within the same word - "ìkòkò"-style) and in wordB at position 0,
    // from the same speaker across two separate registrations.
    await insertWord(wordA, ['ì', targetSyllable, targetSyllable]);
    await insertWord(wordB, [targetSyllable, 'ta']);

    await registerUtterance(
      pool,
      {
        wordId: wordA,
        takeNumber: 2,
        audioData: Buffer.from('wordA-take2'),
        recordedDisplayText: 'ìkòkò',
        recordedSyllables: ['ì', targetSyllable, targetSyllable],
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.2, confidence: 0.9, audioData: Buffer.from('wordA-seg0-i') },
          { syllablePosition: 1, startTimeS: 0.3, endTimeS: 0.5, confidence: 0.9, audioData: Buffer.from('wordA-seg1-ko') },
          { syllablePosition: 2, startTimeS: 0.6, endTimeS: 0.8, confidence: 0.9, audioData: Buffer.from('wordA-seg2-ko') },
        ],
      },
      userId,
      username,
    );
    await registerUtterance(
      pool,
      {
        wordId: wordB,
        takeNumber: 2,
        audioData: Buffer.from('wordB-take2'),
        recordedDisplayText: 'kòta',
        recordedSyllables: [targetSyllable, 'ta'],
        segments: [
          { syllablePosition: 0, startTimeS: 0, endTimeS: 0.2, confidence: 0.9, audioData: Buffer.from('wordB-seg0-ko') },
          { syllablePosition: 1, startTimeS: 0.3, endTimeS: 0.5, confidence: 0.9, audioData: Buffer.from('wordB-seg1-ta') },
        ],
      },
      userId,
      username,
    );

    const results = await listSyllableObservations(pool, targetSyllable);
    // wordA contributes 2 (positions 1 and 2 - the repeated occurrence),
    // wordB contributes 1 (position 0) - 'ta'/'ì' are excluded entirely.
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.speakerDisplayName === username)).toBe(true);

    const fromA = results.filter((r) => r.wordId === wordA).sort((a, b) => a.syllablePosition - b.syllablePosition);
    expect(fromA.map((r) => r.syllablePosition)).toEqual([1, 2]);
    expect(fromA[0].audioDataBase64).toBe(Buffer.from('wordA-seg1-ko').toString('base64'));
    expect(fromA[1].audioDataBase64).toBe(Buffer.from('wordA-seg2-ko').toString('base64'));
    // No distinct raw clip supplied - defaults to the processed bytes.
    expect(fromA[0].rawAudioDataBase64).toBe(Buffer.from('wordA-seg1-ko').toString('base64'));

    const fromB = results.find((r) => r.wordId === wordB)!;
    expect(fromB.syllablePosition).toBe(0);
    expect(fromB.audioDataBase64).toBe(Buffer.from('wordB-seg0-ko').toString('base64'));
  });

  it('excludes a different tone of what is otherwise the same base syllable', async () => {
    const wordId = `${NS}word_c`;
    await insertWord(wordId, [differentToneSyllable]);

    await registerUtterance(
      pool,
      {
        wordId,
        takeNumber: 2,
        audioData: Buffer.from('wordC-take2'),
        recordedDisplayText: differentToneSyllable,
        recordedSyllables: [differentToneSyllable],
        segments: [{ syllablePosition: 0, startTimeS: 0, endTimeS: 0.2, confidence: 0.9, audioData: Buffer.from('wordC-seg0') }],
      },
      userId,
      username,
    );

    expect(await listSyllableObservations(pool, targetSyllable)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ wordId })]),
    );
    const plainMatches = await listSyllableObservations(pool, differentToneSyllable);
    expect(plainMatches.some((r) => r.wordId === wordId)).toBe(true);
  });

  it('returns an empty list for a syllable with no recordings', async () => {
    expect(await listSyllableObservations(pool, `${NS}nonexistent-syllable`)).toEqual([]);
  });
});

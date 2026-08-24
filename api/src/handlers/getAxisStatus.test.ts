import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getAxisStatus } from './getAxisStatus.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testaxisstat_';
const pool = getTestPool();
let userId: string;

beforeAll(async () => {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}requester`, 'Test Requester'],
  );
  userId = result.rows[0].user_id;
});

afterAll(async () => {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    wordId,
    [wordId],
  ]);
}

describe('getAxisStatus', () => {
  it('reports every axis as not-decided/no-audio for a brand-new word', async () => {
    const wordId = `${NS}word_one`;
    await insertWord(wordId);

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result).toEqual({ entry: false, etymology: false, audio: false, audioDiverges: false, example: false });
  });

  it('reports spelling as decided once a word_decisions row exists', async () => {
    const wordId = `${NS}word_two`;
    await insertWord(wordId);
    const user = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}decider`, 'Test Decider'],
    );
    await pool.query("insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', '{}', $2)", [
      wordId,
      user.rows[0].user_id,
    ]);

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result).toEqual({ entry: true, etymology: false, audio: false, audioDiverges: false, example: false });
  });

  it('reports audio as recorded once the REQUESTING user has their own utterance registered', async () => {
    const wordId = `${NS}word_three`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}speaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(true);
  });

  it("does NOT report audio as recorded when only a DIFFERENT user's speaker recorded it - every participant must record every word themselves", async () => {
    const wordId = `${NS}word_four`;
    await insertWord(wordId);
    const otherUser = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
      [`${NS}otheruser`, 'Other User'],
    );
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}otherspeaker`, otherUser.rows[0].user_id],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(false);
  });

  it('keeps reporting audio once the word is re-split, and flags that it will not publish', async () => {
    // Both halves of this area's history are in this one assertion, and neither may be lost.
    //
    // The ORIGINAL gap: the axis asked only "does this user have a row in utterances?", so a word
    // whose spelling or split changed after recording read as DONE while every one of its
    // recordings was being silently dropped from the game export. The axis that should have
    // raised it was the one saying green.
    //
    // The OVERCORRECTION: requiring the match made `audio` answer the publish question instead.
    // A volunteer's spelling correction is a contribution, not a decision, so it never reaches
    // golden_record - and the audio screen then invites them to say the word the way they just
    // argued it should be said. Their recording saved, the axis stayed red, and the task could
    // not be completed by anyone but a curator. A beta tester hit exactly that.
    //
    // So it is two flags, not one: the task is done, and the recording will not ship.
    const wordId = `${NS}word_resplit`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}resplitspeaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );
    expect((await getAxisStatus(pool, wordId, userId)).audio).toBe(true);

    // Re-split the word without touching the recording - exactly what freeing a nasal does.
    await pool.query('update golden_record set syllables = $1 where word_id = $2', [[wordId, 'n̄'], wordId]);

    const after = await getAxisStatus(pool, wordId, userId);
    expect(after.audio).toBe(true);
    expect(after.audioDiverges).toBe(true);
  });

  it('keeps reporting audio once the word is re-spelled, and flags that it will not publish', async () => {
    const wordId = `${NS}word_respelled`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}respellspeaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    await pool.query('update golden_record set display_text = $1 where word_id = $2', [`${wordId}x`, wordId]);

    const after = await getAxisStatus(pool, wordId, userId);
    expect(after.audio).toBe(true);
    expect(after.audioDiverges).toBe(true);
  });

  it('reports no divergence for a recording that still matches', async () => {
    const wordId = `${NS}word_matching`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}matchspeaker`, userId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', $3, $4)`,
      [wordId, speaker.rows[0].speaker_id, wordId, [wordId]],
    );

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(true);
    expect(result.audioDiverges).toBe(false);
  });

  it('never reports divergence for a word with no recording at all', async () => {
    // audioDiverges qualifies a finished task; it must not describe a missing one.
    const wordId = `${NS}word_norecording`;
    await insertWord(wordId);
    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(false);
    expect(result.audioDiverges).toBe(false);
  });

  it('flags divergence when ONE take is stale, even though the other still matches', async () => {
    // bool_and, not bool_or - and this is the case that decides it. A submission writes takes 1
    // and 2, and publish reads both: take 1 for the word clip, take 2's syllable_observations for
    // the syllable clips. Calling the word clean because half of it matches would report coverage
    // that does not exist, and would contradict the per-recording "no longer matches" badges shown
    // on the same screen.
    const wordId = `${NS}word_halfstale`;
    await insertWord(wordId);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}halfstalespeaker`, userId],
    );
    for (const [take, recorded] of [
      [1, wordId],
      [2, `${wordId}_stale`],
    ] as const) {
      await pool.query(
        `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
         values ($1, $2, $3, 'x', $4, $5)`,
        [wordId, speaker.rows[0].speaker_id, take, recorded, [recorded]],
      );
    }

    const result = await getAxisStatus(pool, wordId, userId);
    expect(result.audio).toBe(true);
    expect(result.audioDiverges).toBe(true);
  });

  it('rejects a word_id that does not exist', async () => {
    await expect(getAxisStatus(pool, `${NS}nonexistent`, userId)).rejects.toThrow(WordNotFoundError);
  });
});

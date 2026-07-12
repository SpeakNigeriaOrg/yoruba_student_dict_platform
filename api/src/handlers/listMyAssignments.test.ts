import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listMyAssignments } from './listMyAssignments.js';

const NS = 'testasn_';
const pool = getTestPool();
let userAId: string;
let userBId: string;

beforeAll(async () => {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  const userA = await pool.query<{ user_id: string }>(
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}a@example.com`, 'User A', 'volunteer'],
  );
  userAId = userA.rows[0].user_id;
  const userB = await pool.query<{ user_id: string }>(
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}b@example.com`, 'User B', 'volunteer'],
  );
  userBId = userB.rows[0].user_id;

  await pool.query(
    "insert into golden_record (word_id, display_text, syllables, definition) values ($1, 'epo', array['e','po'], 'oil'), ($2, 'aso', array['a','so'], 'cloth')",
    [`${NS}word1`, `${NS}word2`],
  );
  await pool.query('insert into assignments (word_id, user_id) values ($1, $2), ($3, $2)', [
    `${NS}word1`,
    userAId,
    `${NS}word2`,
  ]);
  await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [`${NS}word1`, userBId]);
});

afterAll(async () => {
  // speakers aren't covered by cleanUpTestData (golden_record's cascade
  // deletes the utterances row it created, but not the speaker row
  // itself) - cleaned explicitly so a re-run never finds this NS's
  // speaker already present.
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('listMyAssignments', () => {
  it("returns only the calling user's assignments, joined with golden_record", async () => {
    const assignments = await listMyAssignments(pool, userAId);
    expect(assignments.map((a) => a.wordId).sort()).toEqual([`${NS}word1`, `${NS}word2`].sort());

    const word1 = assignments.find((a) => a.wordId === `${NS}word1`);
    expect(word1).toMatchObject({ displayText: 'epo', syllables: ['e', 'po'], definition: 'oil', entryType: null });
    expect(word1?.assignedAt).toBeInstanceOf(Date);
    expect(word1?.axisDecided).toEqual({ spelling: false, definition: false, etymology: false, audio: false });
  });

  it("does not leak another user's assignments", async () => {
    const assignments = await listMyAssignments(pool, userBId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].wordId).toBe(`${NS}word1`);
  });

  it('returns an empty list for a user with no assignments', async () => {
    const noAssignmentsUser = await pool.query<{ user_id: string }>(
      'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
      [`${NS}nobody@example.com`, 'Nobody', 'volunteer'],
    );
    const assignments = await listMyAssignments(pool, noAssignmentsUser.rows[0].user_id);
    expect(assignments).toEqual([]);
  });

  it("reports axisDecided.audio true only for the SAME user's own recording, and a word_decisions row as decided for everyone", async () => {
    const decidedResult = await pool.query<{ user_id: string }>(
      "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
      [`${NS}curator`, 'Test Curator'],
    );
    await pool.query("insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'spelling', '{}', $2)", [
      `${NS}word1`,
      decidedResult.rows[0].user_id,
    ]);
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}speaker_a`, userAId],
    );
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, 'x', 'epo', array['e','po'])`,
      [`${NS}word1`, speaker.rows[0].speaker_id],
    );

    const assignmentsA = await listMyAssignments(pool, userAId);
    const word1ForA = assignmentsA.find((a) => a.wordId === `${NS}word1`);
    expect(word1ForA?.axisDecided).toEqual({ spelling: true, definition: false, etymology: false, audio: true });

    const assignmentsB = await listMyAssignments(pool, userBId);
    const word1ForB = assignmentsB.find((a) => a.wordId === `${NS}word1`);
    // spelling: decided is a global fact (a curator decided it) - true
    // for both users. audio: userB hasn't recorded it themselves, so
    // false, even though userA has.
    expect(word1ForB?.axisDecided).toEqual({ spelling: true, definition: false, etymology: false, audio: false });
  });
});

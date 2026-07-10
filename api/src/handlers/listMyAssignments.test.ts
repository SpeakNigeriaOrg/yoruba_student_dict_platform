import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listMyAssignments } from './listMyAssignments.js';

const NS = 'testasn_';
const pool = getTestPool();
let userAId: string;
let userBId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const userA = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}a@example.com`, 'User A', 'volunteer'],
  );
  userAId = userA.rows[0].user_id;
  const userB = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
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
  });

  it("does not leak another user's assignments", async () => {
    const assignments = await listMyAssignments(pool, userBId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].wordId).toBe(`${NS}word1`);
  });

  it('returns an empty list for a user with no assignments', async () => {
    const noAssignmentsUser = await pool.query<{ user_id: string }>(
      'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
      [`${NS}nobody@example.com`, 'Nobody', 'volunteer'],
    );
    const assignments = await listMyAssignments(pool, noAssignmentsUser.rows[0].user_id);
    expect(assignments).toEqual([]);
  });
});

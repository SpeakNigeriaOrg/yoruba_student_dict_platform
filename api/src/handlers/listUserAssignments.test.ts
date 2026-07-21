import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listUserAssignments } from './listUserAssignments.js';
import { UserNotFoundError } from './errors.js';

const NS = 'testlua_';
const pool = getTestPool();
let curatorId: string;
let targetUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);

  const curator = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
    [`${NS}curator`, 'Assigning Curator'],
  );
  curatorId = curator.rows[0].user_id;

  const target = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}target`, 'Target User'],
  );
  targetUserId = target.rows[0].user_id;

  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition) values ($1, 'epo', array['e','po'], 'oil')`,
    [`${NS}word1`],
  );
  await pool.query('insert into assignments (word_id, user_id, assigned_by) values ($1, $2, $3)', [
    `${NS}word1`,
    targetUserId,
    curatorId,
  ]);

  // Independent per-axis status on the one word: spelling in_review,
  // definition not_started, etymology passed.
  await pool.query(
    `insert into contributions (word_id, axis, proposed_value, submitted_by, status)
     values ($1, 'spelling', '{}', $2, 'pending')`,
    [`${NS}word1`, targetUserId],
  );
  await pool.query('insert into word_decisions (word_id, axis, decision, decided_by) values ($1, $2, $3, $4)', [
    `${NS}word1`,
    'etymology',
    '{}',
    curatorId,
  ]);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('listUserAssignments', () => {
  it("returns the target user's assignments with assignedByUsername and independent per-axis reviewStatus", async () => {
    const assignments = await listUserAssignments(pool, targetUserId);
    expect(assignments).toHaveLength(1);
    const word1 = assignments[0];
    expect(word1).toMatchObject({
      wordId: `${NS}word1`,
      displayText: 'epo',
      assignedByUsername: `${NS}curator`,
    });
    expect(word1.reviewStatus).toEqual({
      spelling: 'in_review',
      definition: 'not_started',
      etymology: 'passed',
    });
  });

  it('throws UserNotFoundError for an unknown user id', async () => {
    await expect(listUserAssignments(pool, randomUUID())).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

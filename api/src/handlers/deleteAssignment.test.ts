import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { deleteAssignment } from './deleteAssignment.js';
import { AssignmentNotFoundError } from './errors.js';

const NS = 'testda_';
const pool = getTestPool();
let curatorId: string;
let volunteerId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);

  const curator = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
    [`${NS}curator`, 'Test Curator'],
  );
  curatorId = curator.rows[0].user_id;

  const volunteer = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}volunteer`, 'Test Volunteer'],
  );
  volunteerId = volunteer.rows[0].user_id;

  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition) values ($1, 'epo', array['e','po'], 'oil')`,
    [`${NS}word1`],
  );
  await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [`${NS}word1`, volunteerId]);
  await pool.query(
    `insert into contributions (word_id, axis, proposed_value, submitted_by, status)
     values ($1, 'spelling', '{}', $2, 'pending')`,
    [`${NS}word1`, volunteerId],
  );
  await pool.query('insert into word_decisions (word_id, axis, decision, decided_by) values ($1, $2, $3, $4)', [
    `${NS}word1`,
    'definition',
    '{}',
    curatorId,
  ]);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('deleteAssignment', () => {
  it('removes exactly the assignments row for that (user, word) pair', async () => {
    await deleteAssignment(pool, volunteerId, `${NS}word1`);
    const remaining = await pool.query('select 1 from assignments where user_id = $1 and word_id = $2', [
      volunteerId,
      `${NS}word1`,
    ]);
    expect(remaining.rowCount).toBe(0);
  });

  it('leaves word_decisions and contributions untouched by the unassignment', async () => {
    const decisions = await pool.query('select 1 from word_decisions where word_id = $1', [`${NS}word1`]);
    const contributions = await pool.query('select 1 from contributions where word_id = $1', [`${NS}word1`]);
    expect(decisions.rowCount).toBe(1);
    expect(contributions.rowCount).toBe(1);
  });

  it('throws AssignmentNotFoundError when no such assignment exists', async () => {
    await expect(deleteAssignment(pool, volunteerId, `${NS}word1`)).rejects.toBeInstanceOf(AssignmentNotFoundError);
  });
});

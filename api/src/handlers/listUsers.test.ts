import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listUsers } from './listUsers.js';

const NS = 'testlu_';
const pool = getTestPool();
let curatorId: string;
let volunteerId: string;
let idleUserId: string;

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

  const idle = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}idle`, 'Idle Volunteer'],
  );
  idleUserId = idle.rows[0].user_id;

  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition) values
     ($1, 'epo', array['e','po'], 'oil'),
     ($2, 'aso', array['a','so'], 'cloth')`,
    [`${NS}word1`, `${NS}word2`],
  );
  await pool.query('insert into assignments (word_id, user_id) values ($1, $2), ($3, $2)', [
    `${NS}word1`,
    volunteerId,
    `${NS}word2`,
  ]);

  // word1: one pending contribution on 'spelling' -> in review, not passed.
  await pool.query(
    `insert into contributions (word_id, axis, proposed_value, submitted_by, status)
     values ($1, 'spelling', '{}', $2, 'pending')`,
    [`${NS}word1`, volunteerId],
  );

  // word2: all 3 axes decided -> passed.
  for (const axis of ['spelling', 'definition', 'etymology']) {
    await pool.query('insert into word_decisions (word_id, axis, decision, decided_by) values ($1, $2, $3, $4)', [
      `${NS}word2`,
      axis,
      '{}',
      curatorId,
    ]);
  }
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('listUsers', () => {
  it('returns every user, including one with zero assignments', async () => {
    const users = await listUsers(pool);
    const usernames = users.filter((u) => u.username.startsWith(NS)).map((u) => u.username);
    expect(usernames.sort()).toEqual([`${NS}curator`, `${NS}idle`, `${NS}volunteer`].sort());
  });

  it('computes assigned/inReview/passed counts per user from word_decisions and contributions', async () => {
    const users = await listUsers(pool);
    const volunteer = users.find((u) => u.userId === volunteerId)!;
    expect(volunteer).toMatchObject({
      username: `${NS}volunteer`,
      role: 'volunteer',
      assignedWordCount: 2,
      inReviewCount: 1,
      passedCount: 1,
    });

    const idle = users.find((u) => u.userId === idleUserId)!;
    expect(idle).toMatchObject({ assignedWordCount: 0, inReviewCount: 0, passedCount: 0 });

    const curator = users.find((u) => u.userId === curatorId)!;
    expect(curator).toMatchObject({ role: 'curator', assignedWordCount: 0 });
  });
});

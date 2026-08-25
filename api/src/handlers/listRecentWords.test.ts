import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listRecentWords, RECENT_WORDS_MAX_LIMIT } from './listRecentWords.js';
import { UserNotFoundError } from './errors.js';

const NS = 'testrw_';
const pool = getTestPool();
let curatorId: string;
let volunteerId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);

  const curator = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
    [`${NS}curator`, 'Recent Curator'],
  );
  curatorId = curator.rows[0].user_id;
  const volunteer = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}volunteer`, 'Recent Volunteer'],
  );
  volunteerId = volunteer.rows[0].user_id;

  // created_at is set explicitly rather than left to its default: the whole
  // point of this handler is the order, and three rows inserted in one
  // statement share now() to the microsecond.
  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition, created_at, updated_at) values
     ($1, 'epo', array['e','po'], 'oil',   now() - interval '10 days', now()),
     ($2, 'aso', array['a','so'], 'cloth', now() - interval '2 days',  now() - interval '2 days'),
     ($3, 'omi', array['o','mi'], 'water', now() - interval '1 hour',  now() - interval '1 hour')`,
    [`${NS}old`, `${NS}mid`, `${NS}new`],
  );
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

function ours(rows: { wordId: string }[]) {
  return rows.filter((r) => r.wordId.startsWith(NS));
}

describe('listRecentWords', () => {
  it('returns words newest-added first', async () => {
    const rows = ours(await listRecentWords(pool, volunteerId, RECENT_WORDS_MAX_LIMIT));
    expect(rows.map((r) => r.wordId)).toEqual([`${NS}new`, `${NS}mid`, `${NS}old`]);
  });

  it('orders by created_at, not updated_at - an old word edited today is still old', async () => {
    // `old` has the newest updated_at of the three and the oldest created_at.
    const rows = ours(await listRecentWords(pool, volunteerId, RECENT_WORDS_MAX_LIMIT));
    expect(rows[rows.length - 1].wordId).toBe(`${NS}old`);
  });

  it("flags what the target user already has, and does so per user", async () => {
    await pool.query('insert into assignments (word_id, user_id, assigned_by) values ($1, $2, $3)', [
      `${NS}new`,
      volunteerId,
      curatorId,
    ]);

    const forVolunteer = ours(await listRecentWords(pool, volunteerId, RECENT_WORDS_MAX_LIMIT));
    expect(forVolunteer.find((r) => r.wordId === `${NS}new`)?.alreadyAssigned).toBe(true);
    expect(forVolunteer.find((r) => r.wordId === `${NS}mid`)?.alreadyAssigned).toBe(false);

    const forCurator = ours(await listRecentWords(pool, curatorId, RECENT_WORDS_MAX_LIMIT));
    expect(forCurator.find((r) => r.wordId === `${NS}new`)?.alreadyAssigned).toBe(false);
  });

  it('caps the limit rather than letting a caller page the whole dictionary', async () => {
    const rows = await listRecentWords(pool, volunteerId, 10_000);
    expect(rows.length).toBeLessThanOrEqual(RECENT_WORDS_MAX_LIMIT);
  });

  it('honours a smaller limit', async () => {
    const rows = await listRecentWords(pool, volunteerId, 1);
    expect(rows).toHaveLength(1);
  });

  it('throws UserNotFoundError for an unknown user', async () => {
    await expect(listRecentWords(pool, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

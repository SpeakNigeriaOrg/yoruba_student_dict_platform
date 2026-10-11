import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listRecentWords, RECENT_WORDS_MAX_LIMIT } from './listRecentWords.js';
import { UserNotFoundError, WordNotFoundError } from './errors.js';

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

function ours(page: { words: { wordId: string }[] }) {
  return page.words.filter((r) => r.wordId.startsWith(NS));
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
    const { words } = await listRecentWords(pool, volunteerId, 10_000);
    expect(words.length).toBeLessThanOrEqual(RECENT_WORDS_MAX_LIMIT);
  });

  it('honours a smaller limit, and says there is more', async () => {
    const page = await listRecentWords(pool, volunteerId, 1);
    expect(page.words).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('continues after the `before` word, never repeating it or anything newer', async () => {
    const afterNew = ours(await listRecentWords(pool, volunteerId, RECENT_WORDS_MAX_LIMIT, `${NS}new`));
    expect(afterNew.map((r) => r.wordId)).toEqual([`${NS}mid`, `${NS}old`]);
    const afterMid = ours(await listRecentWords(pool, volunteerId, RECENT_WORDS_MAX_LIMIT, `${NS}mid`));
    expect(afterMid.map((r) => r.wordId)).toEqual([`${NS}old`]);
  });

  it('keeps words sharing one created_at - a bulk import - in order across pages', async () => {
    // Same transaction, same created_at to the microsecond: only word_id orders them.
    await pool.query(
      `insert into golden_record (word_id, display_text, syllables, created_at, updated_at)
       select $1 || n, 'bulk', array['bulk'], timestamp '2001-01-01 00:00:00.123456', now()
       from generate_series(1, 3) as n`,
      [`${NS}bulk`],
    );
    const first = await listRecentWords(pool, volunteerId, 1, `${NS}bulk1`);
    const second = await listRecentWords(pool, volunteerId, 1, `${NS}bulk2`);
    expect(first.words[0].wordId).toBe(`${NS}bulk2`);
    expect(second.words[0].wordId).toBe(`${NS}bulk3`);
  });

  it('throws WordNotFoundError for a `before` word that does not exist', async () => {
    await expect(listRecentWords(pool, volunteerId, 10, `${NS}gone`)).rejects.toBeInstanceOf(WordNotFoundError);
  });

  it('throws UserNotFoundError for an unknown user', async () => {
    await expect(listRecentWords(pool, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

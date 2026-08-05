import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { createAssignments } from './createAssignments.js';
import { UserNotFoundError, WordIdsNotFoundError } from './errors.js';

const NS = 'testca_';
const pool = getTestPool();
let curatorId: string;
let volunteerId: string;

beforeAll(async () => {
  // Speakers aren't covered by cleanUpTestData and hold FKs to users, so
  // they (and their utterances) are cleared explicitly first.
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);

  const curator = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
    [`${NS}curator`, 'Assigning Curator'],
  );
  curatorId = curator.rows[0].user_id;

  const volunteer = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}volunteer`, 'Test Volunteer'],
  );
  volunteerId = volunteer.rows[0].user_id;

  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition) values
     ($1, 'epo', array['e','po'], 'oil'),
     ($2, 'aso', array['a','so'], 'cloth'),
     ($3, 'omi', array['o','mi'], 'water')`,
    [`${NS}word1`, `${NS}word2`, `${NS}word3`],
  );
});

afterAll(async () => {
  // Speakers aren't covered by cleanUpTestData and hold FKs to users, so
  // they (and their utterances) are cleared explicitly first.
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('createAssignments', () => {
  it('assigns a single word', async () => {
    const result = await createAssignments(pool, { userId: volunteerId, wordIds: [`${NS}word1`] }, curatorId);
    expect(result).toEqual({ created: [`${NS}word1`], alreadyAssigned: [] });
  });

  it('bulk-assigns multiple words at once', async () => {
    const result = await createAssignments(pool, { userId: volunteerId, wordIds: [`${NS}word2`, `${NS}word3`] }, curatorId);
    expect(result.created.sort()).toEqual([`${NS}word2`, `${NS}word3`].sort());
    expect(result.alreadyAssigned).toEqual([]);
  });

  it('reports already-assigned words instead of throwing when a list overlaps prior assignments', async () => {
    const result = await createAssignments(
      pool,
      { userId: volunteerId, wordIds: [`${NS}word1`, `${NS}word2`, `${NS}word3`] },
      curatorId,
    );
    expect(result.created).toEqual([]);
    expect(result.alreadyAssigned.sort()).toEqual([`${NS}word1`, `${NS}word2`, `${NS}word3`].sort());
  });

  it('throws WordIdsNotFoundError when a word_id does not exist', async () => {
    await expect(
      createAssignments(pool, { userId: volunteerId, wordIds: [`${NS}word1`, `${NS}nonexistent`] }, curatorId),
    ).rejects.toBeInstanceOf(WordIdsNotFoundError);
  });

  it("scope 'all' assigns every golden_record word without naming any of them", async () => {
    const other = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
      [`${NS}scopeall`, 'Scope All Volunteer'],
    );
    const result = await createAssignments(pool, { userId: other.rows[0].user_id, scope: 'all' }, curatorId);
    // Only asserts our own namespaced words are all present - other test
    // files' golden_record rows may come and go concurrently, so an exact
    // whole-table count would be flaky.
    const assigned = new Set([...result.created, ...result.alreadyAssigned]);
    for (const w of [`${NS}word1`, `${NS}word2`, `${NS}word3`]) expect(assigned.has(w)).toBe(true);
  });

  it("scope 'incomplete' skips words with all four layers done and includes the rest", async () => {
    const other = await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
      [`${NS}scopeinc`, 'Scope Incomplete Volunteer'],
    );
    const otherId = other.rows[0].user_id;

    // word1 gets all three curator decisions plus a recording BY THIS USER -
    // the only fully-complete-for-them word.
    for (const axis of ['entry', 'etymology']) {
      await pool.query(
        "insert into word_decisions (word_id, axis, decision, decided_by) values ($1, $2, '{}'::jsonb, $3) on conflict do nothing",
        [`${NS}word1`, axis, curatorId],
      );
    }
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (user_id, display_name) values ($1, $2) returning speaker_id',
      [otherId, `${NS}speaker`],
    );
    // recorded_display_text/recorded_syllables are NOT NULL as of
    // 0006_utterance_pronunciation.sql - supplied here the same way
    // getAxisStatus.test.ts/listMyAssignments.test.ts already do.
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 1, $3, $4, $5)`,
      [`${NS}word1`, speaker.rows[0].speaker_id, `utterances/${NS}word1.wav`, `${NS}word1`, [`${NS}word1`]],
    );
    // word2 has the decisions but no recording by this user - still incomplete.
    for (const axis of ['entry', 'etymology']) {
      await pool.query(
        "insert into word_decisions (word_id, axis, decision, decided_by) values ($1, $2, '{}'::jsonb, $3) on conflict do nothing",
        [`${NS}word2`, axis, curatorId],
      );
    }

    const result = await createAssignments(pool, { userId: otherId, scope: 'incomplete' }, curatorId);
    const assigned = new Set([...result.created, ...result.alreadyAssigned]);
    expect(assigned.has(`${NS}word1`)).toBe(false);
    expect(assigned.has(`${NS}word2`)).toBe(true);
    expect(assigned.has(`${NS}word3`)).toBe(true);
  });

  it('throws UserNotFoundError for an unknown user id', async () => {
    await expect(createAssignments(pool, { userId: randomUUID(), wordIds: [`${NS}word1`] }, curatorId)).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });
});

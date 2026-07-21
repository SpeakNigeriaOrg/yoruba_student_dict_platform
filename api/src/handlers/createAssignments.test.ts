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
  await cleanUpTestData(pool, NS);

  const curator = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'curator') returning user_id",
    [`${NS}curator`, 'Assigning Curator'],
  );
  curatorId = curator.rows[0].user_id;

  const volunteer = await pool.query<{ user_id: string }>(
    "insert into users (username, display_name, role) values ($1, $2, 'volunteer') returning user_id",
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

  it('throws UserNotFoundError for an unknown user id', async () => {
    await expect(createAssignments(pool, { userId: randomUUID(), wordIds: [`${NS}word1`] }, curatorId)).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });
});

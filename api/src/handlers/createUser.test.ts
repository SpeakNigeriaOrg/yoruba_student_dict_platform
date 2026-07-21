import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { createUser } from './createUser.js';
import { UsernameAlreadyExistsError } from './errors.js';

const NS = 'testcu_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('createUser', () => {
  it('creates a volunteer with a given display name', async () => {
    const user = await createUser(pool, { username: `${NS}newvolunteer`, displayName: 'New Volunteer', role: 'volunteer' });
    expect(user).toMatchObject({ username: `${NS}newvolunteer`, displayName: 'New Volunteer', role: 'volunteer' });
    expect(user.userId).toBeTruthy();
  });

  it('defaults displayName to username when none is given', async () => {
    const user = await createUser(pool, { username: `${NS}nodisplay`, role: 'volunteer' });
    expect(user.displayName).toBe(`${NS}nodisplay`);
  });

  it('creates a pre-registered curator role', async () => {
    const user = await createUser(pool, { username: `${NS}precurator`, role: 'curator' });
    expect(user.role).toBe('curator');
  });

  it('rejects a duplicate username', async () => {
    await createUser(pool, { username: `${NS}dupe`, role: 'volunteer' });
    await expect(createUser(pool, { username: `${NS}dupe`, role: 'volunteer' })).rejects.toBeInstanceOf(
      UsernameAlreadyExistsError,
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { createUser } from './createUser.js';
import { EmailAlreadyExistsError } from './errors.js';

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
    const user = await createUser(pool, {
      email: `${NS}newvolunteer@example.com`,
      displayName: 'New Volunteer',
      role: 'volunteer',
    });
    expect(user).toMatchObject({
      email: `${NS}newvolunteer@example.com`,
      displayName: 'New Volunteer',
      role: 'volunteer',
    });
    expect(user.userId).toBeTruthy();
  });

  it('defaults displayName to the email when none is given', async () => {
    const user = await createUser(pool, { email: `${NS}nodisplay@example.com`, role: 'volunteer' });
    expect(user.displayName).toBe(`${NS}nodisplay@example.com`);
  });

  it('creates a pre-registered curator role', async () => {
    // No Azure Portal invite needed anymore - the roles-source function reads
    // this row, so the role set here is what the user actually gets.
    const user = await createUser(pool, { email: `${NS}precurator@example.com`, role: 'curator' });
    expect(user.role).toBe('curator');
  });

  it('rejects a duplicate email', async () => {
    await createUser(pool, { email: `${NS}dupe@example.com`, role: 'volunteer' });
    await expect(createUser(pool, { email: `${NS}dupe@example.com`, role: 'volunteer' })).rejects.toBeInstanceOf(
      EmailAlreadyExistsError,
    );
  });

  it('normalises the stored email to lowercase', async () => {
    // resolveUser and getRoles both match on lower(email), and the unique
    // index is on lower(email) - storing the canonical form keeps what a
    // curator sees in the Users list consistent with what actually matches.
    const user = await createUser(pool, { email: `${NS}MixedCase@Example.COM`, role: 'volunteer' });
    expect(user.email).toBe(`${NS}mixedcase@example.com`);
  });

  it('rejects a second registration differing only in case', async () => {
    await createUser(pool, { email: `${NS}casedupe@example.com`, role: 'volunteer' });
    await expect(createUser(pool, { email: `${NS}CaseDupe@Example.com`, role: 'volunteer' })).rejects.toBeInstanceOf(
      EmailAlreadyExistsError,
    );
  });
});

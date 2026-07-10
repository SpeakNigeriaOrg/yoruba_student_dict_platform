import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientPrincipal } from '../auth.js';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getRoles } from './getRoles.js';

const NS = 'testgr_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

function principalWithEmail(email: string, userDetails = 'Test User'): ClientPrincipal {
  return {
    identityProvider: 'github',
    userId: 'abc123',
    userDetails,
    userRoles: ['anonymous', 'authenticated'],
    claims: [{ typ: 'email', val: email }],
  };
}

describe('getRoles', () => {
  it('returns no roles for an unauthenticated request', async () => {
    expect(await getRoles(pool, null)).toEqual({ roles: [] });
  });

  it('returns no roles for a principal with no email claim', async () => {
    const principal: ClientPrincipal = { identityProvider: 'github', userId: 'x', userDetails: 'x', userRoles: [] };
    expect(await getRoles(pool, principal)).toEqual({ roles: [] });
  });

  it('provisions a new user as a volunteer (no curator role) on first sight', async () => {
    const email = `${NS}newvol@example.com`;
    const result = await getRoles(pool, principalWithEmail(email));
    expect(result).toEqual({ roles: [] });

    const row = await pool.query<{ role: string }>('select role from users where email = $1', [email]);
    expect(row.rows[0].role).toBe('volunteer');
  });

  it('does not downgrade an existing curator on repeat calls', async () => {
    const email = `${NS}existingcurator@example.com`;
    await pool.query('insert into users (email, display_name, role) values ($1, $2, $3)', [email, 'C', 'curator']);
    const result = await getRoles(pool, principalWithEmail(email));
    expect(result).toEqual({ roles: ['curator'] });
  });

  it('is idempotent - calling it twice for the same new user does not error or duplicate the row', async () => {
    const email = `${NS}repeat@example.com`;
    await getRoles(pool, principalWithEmail(email));
    await getRoles(pool, principalWithEmail(email));
    const row = await pool.query<{ count: string }>('select count(*) as count from users where email = $1', [email]);
    expect(Number(row.rows[0].count)).toBe(1);
  });
});

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

function principalWithUsername(username: string): ClientPrincipal {
  return {
    identityProvider: 'github',
    userId: 'abc123',
    userDetails: username,
    userRoles: ['anonymous', 'authenticated'],
  };
}

describe('getRoles', () => {
  it('returns no roles for an unauthenticated request', async () => {
    expect(await getRoles(pool, null)).toEqual({ roles: [] });
  });

  it('returns no roles for a principal with no userDetails', async () => {
    const principal: ClientPrincipal = { identityProvider: 'github', userId: 'x', userDetails: '', userRoles: [] };
    expect(await getRoles(pool, principal)).toEqual({ roles: [] });
  });

  it('provisions a new user as a volunteer (no curator role) on first sight', async () => {
    const username = `${NS}newvol`;
    const result = await getRoles(pool, principalWithUsername(username));
    expect(result).toEqual({ roles: [] });

    const row = await pool.query<{ role: string }>('select role from users where username = $1', [username]);
    expect(row.rows[0].role).toBe('volunteer');
  });

  it('does not downgrade an existing curator on repeat calls', async () => {
    const username = `${NS}existingcurator`;
    await pool.query('insert into users (username, display_name, role) values ($1, $2, $3)', [username, 'C', 'curator']);
    const result = await getRoles(pool, principalWithUsername(username));
    expect(result).toEqual({ roles: ['curator'] });
  });

  it('is idempotent - calling it twice for the same new user does not error or duplicate the row', async () => {
    const username = `${NS}repeat`;
    await getRoles(pool, principalWithUsername(username));
    await getRoles(pool, principalWithUsername(username));
    const row = await pool.query<{ count: string }>('select count(*) as count from users where username = $1', [username]);
    expect(Number(row.rows[0].count)).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseClientPrincipal, resolveUser, type ClientPrincipal } from './auth.js';
import { cleanUpTestData, getTestPool } from './testSupport.js';

function encodePrincipal(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

const NS = 'testauth_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

function principalWithRoles(username: string, userRoles: string[]): ClientPrincipal {
  return { identityProvider: 'github', userId: 'abc123', userDetails: username, userRoles };
}

describe('parseClientPrincipal', () => {
  it('returns null for a missing header', () => {
    expect(parseClientPrincipal(null)).toBeNull();
    expect(parseClientPrincipal(undefined)).toBeNull();
    expect(parseClientPrincipal('')).toBeNull();
  });

  it('returns null for a header that is not valid base64-encoded JSON', () => {
    expect(parseClientPrincipal('not valid base64 json!!!')).toBeNull();
  });

  it('returns null when the decoded JSON has no userId', () => {
    expect(parseClientPrincipal(encodePrincipal({ userDetails: 'someone' }))).toBeNull();
  });

  it('parses a well-formed SWA client principal header', () => {
    const encoded = encodePrincipal({
      identityProvider: 'github',
      userId: 'abc123',
      userDetails: 'octocat',
      userRoles: ['anonymous', 'authenticated'],
      claims: [{ typ: 'name', val: 'Octo Cat' }],
    });
    expect(parseClientPrincipal(encoded)).toEqual({
      identityProvider: 'github',
      userId: 'abc123',
      userDetails: 'octocat',
      userRoles: ['anonymous', 'authenticated'],
      claims: [{ typ: 'name', val: 'Octo Cat' }],
    });
  });

  it('defaults userRoles to an empty array when absent', () => {
    const encoded = encodePrincipal({ userId: 'abc123' });
    expect(parseClientPrincipal(encoded)?.userRoles).toEqual([]);
  });
});

describe('resolveUser', () => {
  it('returns null when the principal has no userDetails', async () => {
    const principal: ClientPrincipal = { identityProvider: 'github', userId: 'x', userDetails: '', userRoles: [] };
    expect(await resolveUser(pool, principal)).toBeNull();
  });

  it('provisions a new user as volunteer when Azure has not invited them to curator', async () => {
    const username = `${NS}newvolunteer`;
    const user = await resolveUser(pool, principalWithRoles(username, ['anonymous', 'authenticated']));
    expect(user?.role).toBe('volunteer');
  });

  it('provisions a new user as curator when SWA reports the Azure-invited curator role', async () => {
    const username = `${NS}newcurator`;
    const user = await resolveUser(pool, principalWithRoles(username, ['anonymous', 'authenticated', 'curator']));
    expect(user?.role).toBe('curator');
  });

  it('syncs an existing volunteer up to curator once Azure grants the invite', async () => {
    const username = `${NS}getspromoted`;
    await resolveUser(pool, principalWithRoles(username, ['authenticated']));
    const promoted = await resolveUser(pool, principalWithRoles(username, ['authenticated', 'curator']));
    expect(promoted?.role).toBe('curator');
  });

  it('syncs an existing curator back down to volunteer once Azure revokes the invite', async () => {
    const username = `${NS}getsdemoted`;
    await resolveUser(pool, principalWithRoles(username, ['authenticated', 'curator']));
    const demoted = await resolveUser(pool, principalWithRoles(username, ['authenticated']));
    expect(demoted?.role).toBe('volunteer');
  });

  it('is idempotent - repeat calls for the same user do not duplicate the row', async () => {
    const username = `${NS}repeat`;
    await resolveUser(pool, principalWithRoles(username, ['authenticated']));
    await resolveUser(pool, principalWithRoles(username, ['authenticated']));
    const row = await pool.query<{ count: string }>('select count(*) as count from users where username = $1', [username]);
    expect(Number(row.rows[0].count)).toBe(1);
  });
});

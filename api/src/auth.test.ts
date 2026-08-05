import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseClientPrincipal, resolvePrincipalEmail, resolveUser, type ClientPrincipal } from './auth.js';
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

function principal(userDetails: string, userRoles: string[] = ['authenticated'], claims?: ClientPrincipal['claims']): ClientPrincipal {
  return { identityProvider: 'google', userId: 'sub-abc123', userDetails, userRoles, ...(claims ? { claims } : {}) };
}

async function register(email: string, role: 'curator' | 'volunteer'): Promise<string> {
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [email, 'Test User', role],
  );
  return result.rows[0].user_id;
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
    expect(parseClientPrincipal(encodePrincipal({ userDetails: 'someone@example.com' }))).toBeNull();
  });

  it('parses a well-formed SWA client principal header', () => {
    const encoded = encodePrincipal({
      identityProvider: 'google',
      userId: 'sub-abc123',
      userDetails: 'octocat@example.com',
      userRoles: ['anonymous', 'authenticated', 'member'],
      claims: [{ typ: 'name', val: 'Octo Cat' }],
    });
    expect(parseClientPrincipal(encoded)).toEqual({
      identityProvider: 'google',
      userId: 'sub-abc123',
      userDetails: 'octocat@example.com',
      userRoles: ['anonymous', 'authenticated', 'member'],
      claims: [{ typ: 'name', val: 'Octo Cat' }],
    });
  });

  it('defaults userRoles to an empty array when absent', () => {
    const encoded = encodePrincipal({ userId: 'abc123' });
    expect(parseClientPrincipal(encoded)?.userRoles).toEqual([]);
  });
});

describe('resolvePrincipalEmail', () => {
  it('uses userDetails when it looks like an email', () => {
    expect(resolvePrincipalEmail(principal('someone@example.com'))).toBe('someone@example.com');
  });

  it('lowercases and trims', () => {
    expect(resolvePrincipalEmail(principal('  Someone@Example.COM '))).toBe('someone@example.com');
  });

  it('prefers an explicit email claim over userDetails', () => {
    const p = principal('Display Name', ['authenticated'], [
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', val: 'claimed@example.com' },
    ]);
    expect(resolvePrincipalEmail(p)).toBe('claimed@example.com');
  });

  it('returns null when nothing email-shaped is present', () => {
    // A display name is not an identity. Resolving one as an email would let a
    // login match, or create, the wrong row.
    expect(resolvePrincipalEmail(principal('Display Name'))).toBeNull();
    expect(resolvePrincipalEmail(principal(''))).toBeNull();
  });
});

describe('resolveUser', () => {
  it('returns null when the principal carries no email', async () => {
    expect(await resolveUser(pool, principal(''))).toBeNull();
  });

  it('returns null for an authenticated email that was never registered', async () => {
    // The access gate: a successful Google login is identity, not permission.
    // Previously this call would have CREATED a volunteer row here.
    const user = await resolveUser(pool, principal(`${NS}stranger@example.com`));
    expect(user).toBeNull();
  });

  it('does not create a users row for an unregistered email', async () => {
    const email = `${NS}nevercreated@example.com`;
    await resolveUser(pool, principal(email));
    const row = await pool.query('select 1 from users where lower(email) = $1', [email]);
    expect(row.rowCount).toBe(0);
  });

  it('resolves a pre-registered volunteer', async () => {
    const email = `${NS}volunteer@example.com`;
    const userId = await register(email, 'volunteer');
    const user = await resolveUser(pool, principal(email));
    expect(user).toEqual({ userId, email, displayName: 'Test User', role: 'volunteer' });
  });

  it('resolves a pre-registered curator', async () => {
    const email = `${NS}curator@example.com`;
    await register(email, 'curator');
    const user = await resolveUser(pool, principal(email));
    expect(user?.role).toBe('curator');
  });

  describe('the database is authoritative for role, not the SWA principal', () => {
    it('ignores a curator claim in userRoles for a volunteer row', async () => {
      // The inverse of the old behaviour, which overwrote users.role from
      // principal.userRoles on every request. A forged or stale token claiming
      // curator must not confer it.
      const email = `${NS}claimscurator@example.com`;
      await register(email, 'volunteer');
      const user = await resolveUser(pool, principal(email, ['authenticated', 'member', 'curator']));
      expect(user?.role).toBe('volunteer');
    });

    it('keeps a curator row curator even when userRoles omits it', async () => {
      const email = `${NS}staysucurator@example.com`;
      await register(email, 'curator');
      const user = await resolveUser(pool, principal(email, ['authenticated']));
      expect(user?.role).toBe('curator');
    });

    it('does not write to the users row at all', async () => {
      const email = `${NS}unchanged@example.com`;
      await register(email, 'volunteer');
      await resolveUser(pool, principal(email, ['authenticated', 'curator']));
      const row = await pool.query<{ role: string }>('select role from users where lower(email) = $1', [email]);
      expect(row.rows[0].role).toBe('volunteer');
    });
  });

  it('matches case-insensitively, so an invite and a login can differ in case', async () => {
    const email = `${NS}mixedcase@example.com`;
    await register(email, 'volunteer');
    const user = await resolveUser(pool, principal(`${NS}MixedCase@Example.com`));
    expect(user?.email).toBe(email);
  });
});

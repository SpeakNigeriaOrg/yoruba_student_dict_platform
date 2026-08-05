import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getRoles, resolveEmail, type RolesRequestBody } from './getRoles.js';

const NS = 'testroles_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function register(email: string, role: 'curator' | 'volunteer'): Promise<void> {
  await pool.query('insert into users (email, display_name, role) values ($1, $2, $3)', [email, 'Test User', role]);
}

function body(userDetails: string, claims?: RolesRequestBody['claims']): RolesRequestBody {
  return { identityProvider: 'google', userId: 'sub-1', userDetails, accessToken: 'token', ...(claims ? { claims } : {}) };
}

describe('resolveEmail', () => {
  it('reads userDetails when it is email-shaped', () => {
    expect(resolveEmail(body('someone@example.com'))).toBe('someone@example.com');
  });

  it('prefers an explicit email claim', () => {
    const b = body('Display Name', [
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', val: 'claimed@example.com' },
    ]);
    expect(resolveEmail(b)).toBe('claimed@example.com');
  });

  it('normalises case and whitespace', () => {
    expect(resolveEmail(body(' Someone@Example.COM '))).toBe('someone@example.com');
  });

  it('returns null for a body with nothing email-shaped, or no body at all', () => {
    expect(resolveEmail(body('Display Name'))).toBeNull();
    expect(resolveEmail(null)).toBeNull();
    expect(resolveEmail(undefined)).toBeNull();
  });
});

describe('getRoles', () => {
  it('grants no roles to an email with no users row', async () => {
    // This is the pre-registration gate. Every /api/* route requires 'member'
    // or 'curator', so no roles means authenticated but able to reach nothing.
    // 'authenticated' is deliberately not usable for this - SWA grants it to
    // anyone who completes a login.
    expect(await getRoles(pool, body(`${NS}stranger@example.com`))).toEqual({ roles: [] });
  });

  it('does not create a users row for an unknown email', async () => {
    // The pre-Standard version of this function upserted a volunteer row on
    // first sight, which would admit whoever just logged in.
    const email = `${NS}notcreated@example.com`;
    await getRoles(pool, body(email));
    const row = await pool.query('select 1 from users where lower(email) = $1', [email]);
    expect(row.rowCount).toBe(0);
  });

  it("grants 'member' to a registered volunteer", async () => {
    const email = `${NS}volunteer@example.com`;
    await register(email, 'volunteer');
    expect(await getRoles(pool, body(email))).toEqual({ roles: ['member'] });
  });

  it("grants 'member' and 'curator' to a registered curator", async () => {
    const email = `${NS}curator@example.com`;
    await register(email, 'curator');
    const result = await getRoles(pool, body(email));
    expect(result.roles.sort()).toEqual(['curator', 'member']);
  });

  it('grants no roles when the login carries no email', async () => {
    expect(await getRoles(pool, body('Display Name'))).toEqual({ roles: [] });
    expect(await getRoles(pool, null)).toEqual({ roles: [] });
  });

  it('matches case-insensitively against the registered address', async () => {
    const email = `${NS}mixed@example.com`;
    await register(email, 'curator');
    const result = await getRoles(pool, body(`${NS}MIXED@Example.com`));
    expect(result.roles).toContain('curator');
  });

  it('reflects a role change without the user re-registering', async () => {
    // The point of DB-driven roles: promotion is a row update, not an Azure
    // Portal invite.
    const email = `${NS}promoted@example.com`;
    await register(email, 'volunteer');
    expect(await getRoles(pool, body(email))).toEqual({ roles: ['member'] });

    await pool.query("update users set role = 'curator' where lower(email) = $1", [email]);
    const after = await getRoles(pool, body(email));
    expect(after.roles).toContain('curator');
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { CannotDemoteLastCuratorError, updateUserRole } from './updateUserRole.js';
import { UserNotFoundError } from './errors.js';

const NS = 'testrole_';
const pool = getTestPool();

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function register(email: string, role: 'curator' | 'volunteer'): Promise<string> {
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [email, 'Test User', role],
  );
  return result.rows[0].user_id;
}

/** The last-curator guard counts curators globally, so these tests need a
 * curator that is not the one under test. Namespaced so cleanup removes it. */
async function ensureSpareCurator(): Promise<string> {
  return register(`${NS}spare_${randomUUID()}@example.com`, 'curator');
}

describe('updateUserRole', () => {
  it('promotes a volunteer to curator', async () => {
    const userId = await register(`${NS}promote@example.com`, 'volunteer');

    const updated = await updateUserRole(pool, userId, { role: 'curator' });

    expect(updated.role).toBe('curator');
    const row = await pool.query<{ role: string }>('select role from users where user_id = $1', [userId]);
    expect(row.rows[0].role).toBe('curator');
  });

  it('demotes a curator to volunteer when another curator remains', async () => {
    await ensureSpareCurator();
    const userId = await register(`${NS}demote@example.com`, 'curator');

    const updated = await updateUserRole(pool, userId, { role: 'volunteer' });

    expect(updated.role).toBe('volunteer');
  });

  it('returns the full updated user, not just the role', async () => {
    const email = `${NS}shape@example.com`;
    const userId = await register(email, 'volunteer');

    const updated = await updateUserRole(pool, userId, { role: 'curator' });

    expect(updated).toEqual({ userId, email, displayName: 'Test User', role: 'curator' });
  });

  // The last-curator guard counts curators GLOBALLY, so exercising it means
  // establishing "exactly one curator exists" - which cannot be done against
  // the shared database without disturbing other rows. These run inside a
  // transaction that is always rolled back, and demote rather than delete
  // (users.user_id is referenced by word_decisions/assignments/speakers and
  // more, so deleting real curators would fail on a foreign key anyway).
  async function withOnlyOneCurator<T>(fn: (client: import('../db.js').Queryable, soleCuratorId: string) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("update users set role = 'volunteer' where role = 'curator'");
      const inserted = await client.query<{ user_id: string }>(
        "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
        [`${NS}sole_${randomUUID()}@example.com`, 'Sole Curator'],
      );
      return await fn(client, inserted.rows[0].user_id);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  it('refuses to demote the last curator', async () => {
    // Curator is the only role that can grant curator, so allowing this would
    // leave no way back in short of direct SQL.
    await withOnlyOneCurator(async (client, soleCuratorId) => {
      await expect(updateUserRole(client, soleCuratorId, { role: 'volunteer' })).rejects.toBeInstanceOf(
        CannotDemoteLastCuratorError,
      );
      const row = await client.query<{ role: string }>('select role from users where user_id = $1', [soleCuratorId]);
      expect(row.rows[0].role).toBe('curator');
    });
  });

  it('allows a no-op promote of the last curator', async () => {
    await withOnlyOneCurator(async (client, soleCuratorId) => {
      const updated = await updateUserRole(client, soleCuratorId, { role: 'curator' });
      expect(updated.role).toBe('curator');
    });
  });

  it('throws UserNotFoundError for an unknown user id', async () => {
    await expect(updateUserRole(pool, randomUUID(), { role: 'curator' })).rejects.toBeInstanceOf(UserNotFoundError);
    // Also on the demote path, which checks existence before the guard.
    await expect(updateUserRole(pool, randomUUID(), { role: 'volunteer' })).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

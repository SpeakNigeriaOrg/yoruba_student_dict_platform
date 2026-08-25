import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { CannotChangeOwnEmailError, CannotDemoteLastCuratorError, updateUser, updateUserRole } from './updateUserRole.js';
import { EmailAlreadyExistsError, UserNotFoundError } from './errors.js';

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

// ---------------------------------------------------------------------------
// Editing the rest of the account
// ---------------------------------------------------------------------------
//
// An invite is typed by hand before the invitee has ever logged in, so a typo in the email
// is easy to make and silently fatal: getRoles withholds every role from an address with no
// users row, so the person authenticates and reaches nothing. Until now the only repair was
// direct SQL.

describe('updateUser', () => {
  it('corrects a mistyped email', async () => {
    const userId = await register(`${NS}typo@example.com`, 'volunteer');
    const updated = await updateUser(pool, userId, { email: `${NS}fixed@example.com` });

    expect(updated.email).toBe(`${NS}fixed@example.com`);
    const row = await pool.query<{ email: string }>('select email from users where user_id = $1', [userId]);
    expect(row.rows[0].email).toBe(`${NS}fixed@example.com`);
  });

  it('stores the email lowercased, because every lookup is on lower(email)', async () => {
    // A row saved in whatever case a curator happened to type would simply never match a
    // login - the same reason createUser normalises.
    const userId = await register(`${NS}case@example.com`, 'volunteer');
    const updated = await updateUser(pool, userId, { email: `  ${NS}MiXeD@Example.COM  ` });
    expect(updated.email).toBe(`${NS}mixed@example.com`);
  });

  it('refuses an email another account already holds', async () => {
    const taken = `${NS}taken@example.com`;
    await register(taken, 'volunteer');
    const userId = await register(`${NS}mover@example.com`, 'volunteer');

    await expect(updateUser(pool, userId, { email: taken })).rejects.toBeInstanceOf(EmailAlreadyExistsError);
    // And the row is untouched, rather than half-applied.
    const row = await pool.query<{ email: string }>('select email from users where user_id = $1', [userId]);
    expect(row.rows[0].email).toBe(`${NS}mover@example.com`);
  });

  it('refuses a curator changing their OWN email, which would lock them out at next sign-in', async () => {
    const userId = await register(`${NS}self@example.com`, 'curator');
    await expect(
      updateUser(pool, userId, { email: `${NS}newself@example.com` }, userId),
    ).rejects.toBeInstanceOf(CannotChangeOwnEmailError);
  });

  it('lets another curator change that same email for them', async () => {
    // The honest route: it takes someone who will still be able to log in afterwards.
    const subject = await register(`${NS}subject@example.com`, 'curator');
    const other = await ensureSpareCurator();
    const updated = await updateUser(pool, subject, { email: `${NS}moved@example.com` }, other);
    expect(updated.email).toBe(`${NS}moved@example.com`);
  });

  it('sets and clears the display name, telling absent apart from cleared', async () => {
    const userId = await register(`${NS}named@example.com`, 'volunteer');

    expect((await updateUser(pool, userId, { displayName: 'Ada Lovelace' })).displayName).toBe('Ada Lovelace');
    // Omitted means leave alone, not blank out.
    expect((await updateUser(pool, userId, { role: 'volunteer' })).displayName).toBe('Ada Lovelace');
    // Explicit null clears it, and so does an empty string - "no display name" has one
    // representation, so the email fallback everywhere else keeps working.
    expect((await updateUser(pool, userId, { displayName: null })).displayName).toBeNull();
    expect((await updateUser(pool, userId, { displayName: 'Ada' })).displayName).toBe('Ada');
    expect((await updateUser(pool, userId, { displayName: '   ' })).displayName).toBeNull();
  });

  it('changes several fields in one call', async () => {
    const userId = await register(`${NS}multi@example.com`, 'volunteer');
    const other = await ensureSpareCurator();
    const updated = await updateUser(
      pool,
      userId,
      { email: `${NS}multi2@example.com`, displayName: 'Renamed', role: 'curator' },
      other,
    );
    expect(updated).toMatchObject({ email: `${NS}multi2@example.com`, displayName: 'Renamed', role: 'curator' });
  });

  it('refuses an empty patch rather than issuing an update that sets nothing', async () => {
    const userId = await register(`${NS}empty@example.com`, 'volunteer');
    await expect(updateUser(pool, userId, {})).rejects.toThrow(/nothing to update/);
  });

  it('still guards the last curator when the role rides along with other fields', async () => {
    const userId = await register(`${NS}lastone@example.com`, 'curator');
    await pool.query("delete from users where role = 'curator' and user_id <> $1 and email like $2", [
      userId,
      `${NS}%`,
    ]);
    const others = await pool.query<{ count: string }>("select count(*) as count from users where role = 'curator'");
    if (Number(others.rows[0].count) > 1) return; // a real curator exists outside the namespace

    await expect(
      updateUser(pool, userId, { role: 'volunteer', displayName: 'Demoted' }),
    ).rejects.toBeInstanceOf(CannotDemoteLastCuratorError);
  });

  it('reports a missing user rather than silently updating nothing', async () => {
    await expect(updateUser(pool, randomUUID(), { displayName: 'Ghost' })).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

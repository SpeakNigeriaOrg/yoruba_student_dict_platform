// db.ts
//
// A single pg Pool per Functions host instance, lazily created - Azure
// Functions reuses the same Node process across invocations, so a pool
// created on first use is shared (and reused) across every subsequent
// request in that instance, rather than opening a new connection per call.

import pg from 'pg';

// Handlers are written against this minimal interface (satisfied by both
// pg.Pool and pg.PoolClient/pg.Client) rather than pg.Pool directly, so
// tests can pass a single transactional client instead - every test wraps
// its handler call in begin/rollback on one real connection, exactly like
// the manual Postgres verification used elsewhere in this repo, just
// wrapped in Vitest instead of a one-off psql session.
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

/** Runs fn inside a transaction on a single client, committing on success
 * and rolling back on any thrown error - every handler that writes more
 * than one row (a content change plus a word_decisions/contributions row)
 * uses this so a partial write is never possible. */
/** Postgres unique-violation. Lived in three handlers as three identical private copies. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === '23505');
}

/** Runs `fn` so a constraint violation inside it can be RECOVERED from rather than aborting the
 * caller's whole transaction.
 *
 * Needed because a failed statement poisons a Postgres transaction: every later query errors until
 * rollback, so the natural "catch the violation and re-read to see who beat me" is impossible without
 * a savepoint to roll back to. Returns null when `fn` hit a unique violation, so the caller can decide
 * what the collision MEANS - which is usually not "error".
 */
export async function trySavepoint<T>(client: Queryable, name: string, fn: () => Promise<T>): Promise<T | null> {
  // A savepoint is only meaningful inside a transaction. Given a plain pool - autocommit, where each
  // statement stands alone - there is nothing to poison and nothing to roll back to, so run directly.
  // 25P01 (no_active_sql_transaction) is how Postgres says so; verified rather than assumed.
  let inTransaction = true;
  try {
    await client.query(`savepoint ${name}`);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '25P01') inTransaction = false;
    else throw err;
  }

  try {
    const result = await fn();
    if (inTransaction) await client.query(`release savepoint ${name}`);
    return result;
  } catch (err) {
    if (inTransaction) await client.query(`rollback to savepoint ${name}`);
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

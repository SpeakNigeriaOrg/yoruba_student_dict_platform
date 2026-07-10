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

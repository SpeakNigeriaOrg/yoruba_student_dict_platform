// db.ts
//
// Same Queryable/withTransaction pattern as api/src/db.ts - handlers are
// written against this minimal interface (satisfied by both pg.Pool and
// pg.PoolClient/pg.Client) rather than a concrete pg type, so tests can
// pass a single connection instead.

import pg from 'pg';

export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

export function getPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new pg.Pool({ connectionString });
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

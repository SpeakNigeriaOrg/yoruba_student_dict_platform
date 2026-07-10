// testSupport.ts
//
// Test-only helpers for running handler tests against a real local
// Postgres instance (same db/migrations/0001_initial_schema.sql schema
// used everywhere else in this repo) rather than mocking pg. Not imported
// by any non-test code.
//
// Vitest runs test files concurrently by default, and they all share this
// one real database - so cleanup is scoped by a per-FILE namespace prefix
// (e.g. "testcw_" for createWord.test.ts), not a single global pattern.
// Two files racing to clean up the SAME broad pattern is exactly what
// caused real cross-file test failures the first time this was written
// with one shared "test_" prefix for everything.

import pg from 'pg';

export function getTestPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set - export it before running `npm test` (see local.settings.json.example)');
  }
  return new pg.Pool({ connectionString });
}

/** Deletes every row a test file could plausibly have created, scoped to
 * that file's own namespace prefix. golden_record_components rows are
 * deleted explicitly first (both sides - a namespaced phrase's own rows,
 * and any row where a namespaced word is referenced AS a component) since
 * component_word_id has no ON DELETE CASCADE (deleting a word that's still
 * referenced as someone else's component should fail loudly in real
 * usage, per db/migrations/0001) - deleting golden_record directly first
 * would hit that same real constraint. golden_record's own ON DELETE
 * CASCADE still handles word_decisions/contributions/assignments/
 * utterances/its own components rows. */
export async function cleanUpTestData(pool: pg.Pool, namespace: string): Promise<void> {
  await pool.query('delete from golden_record_components where word_id like $1 or component_word_id like $1', [
    `${namespace}%`,
  ]);
  await pool.query('delete from golden_record where word_id like $1', [`${namespace}%`]);
  await pool.query('delete from users where email like $1', [`${namespace}%@example.com`]);
}

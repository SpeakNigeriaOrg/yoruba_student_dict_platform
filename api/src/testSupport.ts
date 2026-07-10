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
 * that file's own namespace prefix.
 *
 * Order matters, and each step closes a real gap found while writing this:
 *   1. golden_record_components, explicitly, both sides (a namespaced
 *      phrase's own rows, and any row where a namespaced word is
 *      referenced AS a component) - component_word_id has no
 *      ON DELETE CASCADE (deleting a word still referenced as someone
 *      else's component should fail loudly in real usage), so deleting
 *      golden_record directly first would hit that same real constraint.
 *   2. contributions, explicitly, matched by word_id OR by submitted_by/
 *      reviewed_by belonging to a namespaced user - a 'new_entry'
 *      contribution's word_id is null, so golden_record's own
 *      ON DELETE CASCADE never reaches it, and contributions.submitted_by
 *      has no ON DELETE CASCADE either, so an orphaned row here blocks
 *      step 4 from deleting the user that submitted it.
 *   3. golden_record itself - cascades word_decisions/assignments/
 *      utterances/its own components rows and any now-empty contributions
 *      reference.
 *   4. users. */
export async function cleanUpTestData(pool: pg.Pool, namespace: string): Promise<void> {
  const wordPattern = `${namespace}%`;
  const emailPattern = `${namespace}%@example.com`;

  await pool.query('delete from golden_record_components where word_id like $1 or component_word_id like $1', [wordPattern]);
  await pool.query(
    `delete from contributions
     where word_id like $1
        or submitted_by in (select user_id from users where email like $2)
        or reviewed_by in (select user_id from users where email like $2)`,
    [wordPattern, emailPattern],
  );
  await pool.query('delete from golden_record where word_id like $1', [wordPattern]);
  await pool.query('delete from users where email like $1', [emailPattern]);
}

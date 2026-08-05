// testSupport.ts
//
// Test-only helpers for running handler tests against a real local
// Postgres instance (same db/migrations/0001_initial_schema.sql schema
// used everywhere else in this repo) rather than mocking pg. Not imported
// by any non-test code.
//
// All test files share this one real database, so cleanup is scoped by a
// per-FILE namespace prefix (e.g. "testcw_" for createWord.test.ts), not a
// single global pattern. Two files racing to clean up the SAME broad
// pattern is exactly what caused real cross-file test failures the first
// time this was written with one shared "test_" prefix for everything.
//
// Two things make that scoping actually hold, both learned the hard way:
//
//   1. The namespace is escaped for LIKE below. Every namespace here ends
//      in '_', which is LIKE's single-character WILDCARD - so an unescaped
//      "testlu_%" (listUsers.test.ts) also matches "testlua_word1"
//      (listUserAssignments.test.ts), and one file silently deleted the
//      other's rows mid-run. That produced exactly the intermittent
//      cross-file failures the namespace scheme was introduced to prevent.
//
//   2. vitest.config.ts sets fileParallelism: false. Namespacing keeps
//      files from deleting each other's rows, but it cannot make
//      whole-table operations safe: createAssignments' scope: 'all' reads
//      every golden_record row and then inserts assignments referencing
//      them, so a concurrent file dropping one of its own words between
//      those two statements breaks the FK. One shared mutable database
//      means one test file at a time.

import pg from 'pg';

/** Escapes LIKE's wildcards (% and _) so a namespace prefix matches
 * literally. See note 1 above - this is not cosmetic. */
function likePrefix(namespace: string): string {
  return `${namespace.replace(/([%_\\])/g, '\\$1')}%`;
}

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
 *   3. assignments, explicitly, matched by word_id OR by user_id/assigned_by
 *      belonging to a namespaced user - assigned_by has no ON DELETE
 *      CASCADE (only user_id does), so an assignment this namespace's
 *      curator made against a word OUTSIDE the namespace survives step 4's
 *      golden_record delete and then blocks step 5 on
 *      assignments_assigned_by_fkey. That is not hypothetical: the
 *      scope: 'all' path assigns every row in golden_record, so any word
 *      this test file didn't create - a real dev vocabulary, another
 *      namespace's leftovers - lands here. Without this step
 *      createAssignments.test.ts passes only against an empty database.
 *   4. golden_record itself - cascades word_decisions/assignments/
 *      utterances/its own components rows and any now-empty contributions
 *      reference.
 *   5. users. */
export async function cleanUpTestData(pool: pg.Pool, namespace: string): Promise<void> {
  const wordPattern = likePrefix(namespace);
  const usernamePattern = likePrefix(namespace);

  await pool.query('delete from golden_record_components where word_id like $1 or component_word_id like $1', [wordPattern]);
  await pool.query(
    `delete from contributions
     where word_id like $1
        or submitted_by in (select user_id from users where email like $2)
        or reviewed_by in (select user_id from users where email like $2)`,
    [wordPattern, usernamePattern],
  );
  await pool.query(
    `delete from assignments
     where word_id like $1
        or user_id in (select user_id from users where email like $2)
        or assigned_by in (select user_id from users where email like $2)`,
    [wordPattern, usernamePattern],
  );
  await pool.query('delete from golden_record where word_id like $1', [wordPattern]);
  await pool.query('delete from users where email like $1', [usernamePattern]);
}

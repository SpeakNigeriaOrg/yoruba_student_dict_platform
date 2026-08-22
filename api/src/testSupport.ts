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
  // word_examples.submitted_by has no ON DELETE CASCADE (deliberately - an example is a
  // contribution, and removing a user should not silently destroy what they said), so an
  // example by a namespaced user against a word OUTSIDE the namespace would survive the
  // golden_record delete below and then block the users delete. Same shape as the
  // assignments.assigned_by case in note 1's neighbour above.
  await pool.query(
    `delete from word_examples
     where word_id like $1
        or submitted_by in (select user_id from users where email like $2)
        or excluded_by in (select user_id from users where email like $2)`,
    [wordPattern, usernamePattern],
  );
  // 0011's archive of the pre-merge spelling/definition decisions has no foreign key (it is
  // a rollback path, kept deliberately independent of the live table), so golden_record's
  // cascade never reaches it and a test that writes one would leave it behind for good.
  await pool.query('delete from word_decisions_premerge where word_id like $1', [wordPattern]);
  await pool.query('delete from golden_record where word_id like $1', [wordPattern]);
  await pool.query('delete from users where email like $1', [usernamePattern]);
}

/** A Kaikki etymology for a citation to point at.
 *
 * kaikki_senses is deliberately NOT covered by cleanUpTestData: it is the shared
 * ingested corpus keyed by upstream ids, not by this repo's word_id namespaces,
 * so a prefix delete there would be a delete against real corpus data. Callers
 * insert what they need and remove it with deleteTestKaikkiSenses, scoping by an
 * entry_id prefix they own.
 *
 * upstream_citations needs no such handling - its word_id cascades from
 * golden_record, so step 4 above already removes it. */
export async function insertTestKaikkiSense(
  pool: pg.Pool,
  sense: {
    entryId: string;
    headword: string;
    canonicalValue: string;
    glosses: string[];
    pos?: string;
    etymologyNumber?: string | null;
    etymologyText?: string | null;
    standardForms?: string[];
  },
): Promise<void> {
  await pool.query(
    `insert into kaikki_senses
       (entry_id, pos, etymology_number, etymology_text, headword, canonical_value,
        canonical_inference_method, canonical_confidence, canonical_original_value,
        standard_forms, glosses, alt_of_targets)
     values ($1, $2, $3, $4, $5, $6, 'explicit_canonical_tag', 1.0, $6, $7, $8, '{}')`,
    [
      sense.entryId,
      sense.pos ?? 'verb',
      sense.etymologyNumber ?? null,
      sense.etymologyText ?? null,
      sense.headword,
      sense.canonicalValue,
      sense.standardForms ?? [sense.canonicalValue],
      sense.glosses,
    ],
  );
}

export async function deleteTestKaikkiSenses(pool: pg.Pool, entryIdPrefix: string): Promise<void> {
  await pool.query('delete from kaikki_senses where entry_id like $1', [likePrefix(entryIdPrefix)]);
}

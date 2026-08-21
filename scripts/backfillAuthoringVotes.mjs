// backfillAuthoringVotes.mjs
//
// Gives words created before authoringVote.ts the author's vote they were
// created without.
//
// A word added today records its author's position as one ordinary
// contribution, so a volunteer who later disagrees makes the word 'contested'
// instead of quietly outvoting nobody. Everything created earlier holds no such
// vote, so the existing corpus still has the gap: two agreeing volunteers reach
// the bulk-confirm queue looking uncontested.
//
// WHAT IT TOUCHES: rows in `contributions`, and nothing else. No golden_record,
// no components, no citations, no decisions, and nothing in utterances,
// speakers or syllable_observations. Seeded words keep their spellings and
// their audio, including recordings attached to placeholder speakers.
//
// It never supersedes an existing vote by the same user, and skips any axis
// already carrying a decision. Those are reported, not written.
//
// Attribution is a choice: golden_record.updated_by is the last person to touch
// a row rather than its author, and is often null for the imported vocabulary.
// Every vote is attributed to --by, and its note says it was backfilled.
//
// All the logic lives in api/src/handlers/backfillAuthoringVotes.ts, tested
// against real Postgres. This file is argument parsing and a report.
//
// Usage:
//   node scripts/backfillAuthoringVotes.mjs --by admin@speaknigeria.org           # dry run
//   node scripts/backfillAuthoringVotes.mjs --by admin@speaknigeria.org --apply
//
// Requires DATABASE_URL, and `npm run build:api` to have been run.

import pg from 'pg';
import {
  planAuthoringVoteBackfill,
  applyAuthoringVoteBackfill,
} from '../api/dist/handlers/backfillAuthoringVotes.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const byIndex = args.indexOf('--by');
const byEmail = byIndex !== -1 ? args[byIndex + 1] : null;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!byEmail) {
  console.error('--by <email> is required: every backfilled vote is attributed to one named user.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  const user = await pool.query('select user_id, role from users where email = $1', [byEmail]);
  if (user.rowCount === 0) {
    console.error(`No user with email ${byEmail}.`);
    process.exit(1);
  }
  const { user_id: userId, role } = user.rows[0];

  const plan = await planAuthoringVoteBackfill(pool, userId);
  const bucket = (reason) => plan.skipped.filter((s) => s.reason === reason).length;

  console.log(`Attributing to ${byEmail} (${role}).`);
  console.log(`  ${plan.planned.length} votes to cast`);
  console.log(`    entry:     ${plan.planned.filter((p) => p.axis === 'entry').length}`);
  console.log(`    etymology: ${plan.planned.filter((p) => p.axis === 'etymology').length}`);
  console.log(`  skipped:`);
  console.log(`    ${bucket('no_components')} etymology - nothing on record to vote for`);
  console.log(`    ${bucket('already_voted')} - this user has already voted there`);
  console.log(`    ${bucket('already_decided')} - the axis is already decided`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    process.exit(0);
  }

  const result = await applyAuthoringVoteBackfill(pool, userId, plan);
  console.log(`\nWrote ${result.written} contribution rows.`);
  if (result.failed.length > 0) {
    console.log(`${result.failed.length} failed:`);
    for (const f of result.failed) console.log(`  ${f.wordId} (${f.axis}): ${f.error}`);
  }
} finally {
  await pool.end();
}

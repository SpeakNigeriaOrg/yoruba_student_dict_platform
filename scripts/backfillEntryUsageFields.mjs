// backfillEntryUsageFields.mjs
//
// Brings every stored entry-axis vote and decision up to the current claim layout, so an older
// vote and a new one confirming the same word agree instead of reading as a conflict:
//   extend      - rows from before 0029 gain part of speech, usage labels and the flag
//   affix_flag  - rows asserting an affix under 0029 get the flag turned on, as 0030 requires
// Run after migrating (0029 and 0030) and deploying.
//
// WHAT IT TOUCHES: contributions.resolved_value / value_fingerprint and
// word_decisions.value_fingerprint, for entry-axis rows whose fingerprint predates 0029. Nothing
// else - no golden_record, no new votes, nothing superseded. It is attributed to nobody, because it
// adds nothing anyone said: see api/src/handlers/backfillEntryUsageFields.ts, where the logic
// lives and is tested against real Postgres.
//
// Idempotent: run it again and it finds nothing to do.
//
// Usage:
//   node scripts/backfillEntryUsageFields.mjs            # dry run
//   node scripts/backfillEntryUsageFields.mjs --apply
//
// Requires DATABASE_URL, migration 0029 applied, and `npm run build:api` to have been run.

import pg from 'pg';
import { planEntryUsageBackfill, applyEntryUsageBackfill } from '../api/dist/handlers/backfillEntryUsageFields.js';

const apply = process.argv.slice(2).includes('--apply');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  const plan = await planEntryUsageBackfill(pool);
  const n = (repair, kind) => plan.planned.filter((p) => p.repair === repair && p.kind === kind).length;
  console.log(`${plan.planned.length} entry fingerprints to bring up to date`);
  console.log(`  extend (pre-0029):   ${n('extend', 'contribution')} contributions, ${n('extend', 'decision')} decisions`);
  console.log(`  affix flag (0030):   ${n('affix_flag', 'contribution')} contributions, ${n('affix_flag', 'decision')} decisions`);
  for (const p of plan.planned.filter((q) => q.repair === 'affix_flag')) console.log(`    ${p.kind} on ${p.wordId} (${p.pos})`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    process.exit(0);
  }

  const result = await applyEntryUsageBackfill(pool, plan);
  console.log(`\nCompleted ${result.written} rows.`);
  if (result.failed.length > 0) {
    console.log(`${result.failed.length} failed:`);
    for (const f of result.failed) console.log(`  ${f.kind} ${f.id} (${f.wordId}): ${f.error}`);
  }
} finally {
  await pool.end();
}

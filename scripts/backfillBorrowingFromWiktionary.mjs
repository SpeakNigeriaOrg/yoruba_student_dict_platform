// backfillBorrowingFromWiktionary.mjs
//
// Gives existing cited words the loanword answer their Wiktionary entry states, and completes the
// etymology votes and decisions made before 0032 with it - so a reviewer confirming Wiktionary's
// answer agrees with them instead of conflicting. See api/src/handlers/backfillBorrowingFromWiktionary.ts,
// where the logic lives and is tested against real Postgres.
//
// Only votes and decisions dated before --before are touched (default: the 0032 deploy,
// 2026-10-02T18:39:12Z): anything later is a person's real answer and is never rewritten.
// Idempotent.
//
// Usage:
//   node scripts/backfillBorrowingFromWiktionary.mjs            # dry run: lists the words
//   node scripts/backfillBorrowingFromWiktionary.mjs --apply
//
// Requires DATABASE_URL, migration 0032, an ingest since 0032, and `npm run build:api`.

import pg from 'pg';
import { planBorrowingBackfill, applyBorrowingBackfill } from '../api/dist/handlers/backfillBorrowingFromWiktionary.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const beforeIndex = args.indexOf('--before');
const before = beforeIndex !== -1 ? args[beforeIndex + 1] : '2026-10-02T18:39:12Z';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
try {
  const plan = await planBorrowingBackfill(pool, before);
  console.log(`${plan.planned.length} cited words to mark as loanwords from Wiktionary (votes/decisions before ${before}):`);
  for (const i of plan.planned) {
    console.log(
      `  ${i.displayText.padEnd(12)} ${i.wordId.padEnd(28)} from ${i.borrowedFrom}${i.borrowedTerm ? ` (${i.borrowedTerm})` : ''}` +
        `   ${i.votes} vote(s), ${i.decisions} decision(s)`,
    );
  }
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    process.exit(0);
  }
  const result = await applyBorrowingBackfill(pool, plan);
  console.log(`\nUpdated ${result.written} words.`);
  for (const f of result.failed) console.log(`  FAILED ${f.wordId}: ${f.error}`);
} finally {
  await pool.end();
}

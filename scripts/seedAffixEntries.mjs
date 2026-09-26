// seedAffixEntries.mjs
//
// Adds Yoruba's affixes to the dictionary: every affix Wiktionary has an entry for (cited), and
// every affix that appears as an etymology part without one (exempt, glossed with the gloss the
// etymology templates most often give it). See api/src/handlers/seedAffixEntries.ts, where the
// logic lives and is tested against real Postgres.
//
// Run AFTER migration 0031 and a fresh ingest (which keeps affixes as etymology parts).
//
// Usage:
//   node scripts/seedAffixEntries.mjs --by admin@speaknigeria.org            # dry run: prints the list
//   node scripts/seedAffixEntries.mjs --by admin@speaknigeria.org --apply
//
// Requires DATABASE_URL, and `npm run build:api` to have been run.

import pg from 'pg';
import { planAffixSeed, applyAffixSeed } from '../api/dist/handlers/seedAffixEntries.js';

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
  console.error('--by <email> is required: every seeded entry is created by, and votes as, one named user.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  const user = await pool.query('select user_id from users where email = $1', [byEmail]);
  if (user.rowCount === 0) {
    console.error(`No user with email ${byEmail}.`);
    process.exit(1);
  }
  const plan = await planAffixSeed(pool);

  const row = (i) =>
    `  ${i.displayText.padEnd(8)} ${i.pos.padEnd(9)} ${String(i.uses).padStart(4)} uses  ${i.wordId.padEnd(52)} ${i.gloss ?? '(NO GLOSS - needs a curator)'}`;
  const cited = plan.planned.filter((i) => i.kind === 'cited');
  const exempt = plan.planned.filter((i) => i.kind === 'exempt');
  console.log(`${plan.planned.length} affix entries to create`);
  console.log(`\nCited - Wiktionary has an entry (${cited.length}):`);
  for (const i of cited) console.log(row(i));
  console.log(`\nNo Wiktionary entry - exempt (${exempt.length}):`);
  for (const i of exempt) console.log(row(i));
  if (plan.skipped.length > 0) {
    console.log(`\nSkipped (${plan.skipped.length}):`);
    for (const s of plan.skipped) console.log(`  ${s.displayText.padEnd(8)} ${s.reason} (${s.existingWordId})`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    process.exit(0);
  }
  const result = await applyAffixSeed(pool, plan, user.rows[0].user_id);
  console.log(`\nCreated ${result.written} entries.`);
  if (result.failed.length > 0) {
    console.log(`${result.failed.length} failed:`);
    for (const f of result.failed) console.log(`  ${f.displayText} (${f.wordId}): ${f.error}`);
  }
} finally {
  await pool.end();
}

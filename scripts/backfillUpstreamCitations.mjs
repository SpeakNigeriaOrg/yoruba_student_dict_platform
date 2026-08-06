// backfillUpstreamCitations.mjs
//
// Gives every pre-existing word the upstream citation it was created without.
//
// A word added today records which Wiktionary etymology it IS at creation
// (api/src/handlers/createWord.ts), because adding a word is choosing one. The
// existing vocabulary predates that: it arrived from an earlier data source
// carrying only spellings, so its identity has to be recovered by matching forms
// back against the corpus - the very operation the citation model exists to
// abolish, because a spelling does not identify a word (`kọ́` is three
// etymologies).
//
// So this is a one-off repair, and it is deliberately unable to finish the job on
// its own. Where one spelling matches several etymologies there is nothing to
// recover and it reports the word for a human instead of guessing. Guessing here
// would be the worst possible outcome: a confident, wrong, permanent citation
// that looks exactly like a correct one.
//
// All the decision logic lives in api/src/handlers/backfillCitations.ts, tested
// against real Postgres. This file is argument parsing and a report.
//
// Usage:
//   node scripts/backfillUpstreamCitations.mjs                  # dry run (default)
//   node scripts/backfillUpstreamCitations.mjs --apply
//   node scripts/backfillUpstreamCitations.mjs --apply --by admin@speaknigeria.org
//
// Requires DATABASE_URL, and `npm run build:api` to have been run.

import pg from 'pg';
import { planCitationBackfill, applyCitationBackfill } from '../api/dist/handlers/backfillCitations.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const byIndex = args.indexOf('--by');
const byEmail = byIndex !== -1 ? args[byIndex + 1] : null;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const OUTCOME_LABELS = {
  auto_link: 'linked to one unambiguous etymology',
  exempt_phrase: 'exempt: phrase (identity comes from its components)',
  exempt_multiword: 'exempt: multi-word entry',
  exempt_absent: 'exempt: genuinely absent from Wiktionary',
  needs_curator: 'NEEDS A CURATOR: one spelling, several etymologies',
  already_cited: 'already cited (nothing to do)',
};

const pool = new pg.Pool({ connectionString });

try {
  let appliedBy = null;
  if (byEmail) {
    const { rows } = await pool.query('select user_id, role from users where lower(email) = lower($1)', [byEmail]);
    if (rows.length === 0) {
      console.error(`No user with email ${byEmail}.`);
      process.exit(1);
    }
    appliedBy = rows[0].user_id;
    console.log(`Attributing pins to ${byEmail} (${rows[0].role}).\n`);
  } else {
    // pinned_by is nullable and is provenance only, so this is a warning rather
    // than a failure - but an attributed backfill is easier to reason about later.
    console.log('No --by given: pins will be recorded with no author.\n');
  }

  const plan = await planCitationBackfill(pool);

  console.log(`${plan.items.length} words in golden_record.\n`);
  for (const [outcome, label] of Object.entries(OUTCOME_LABELS)) {
    const count = plan.counts[outcome] ?? 0;
    if (count > 0) console.log(`  ${String(count).padStart(4)}  ${label}`);
  }

  const autoLinked = plan.items.filter((i) => i.outcome === 'auto_link');
  if (autoLinked.length > 0) {
    console.log(`\n--- would link (${autoLinked.length}) ---`);
    for (const item of autoLinked) {
      const etym = item.etymologyNumber ? `etym ${item.etymologyNumber}` : 'no etym number';
      console.log(`  ${item.wordId}  (${item.displayText})  ->  ${item.entryId}  [${etym}]  ${(item.glosses ?? []).join('; ')}`);
    }
  }

  const exempt = plan.items.filter((i) => i.outcome.startsWith('exempt_'));
  if (exempt.length > 0) {
    console.log(`\n--- would exempt (${exempt.length}) ---`);
    for (const item of exempt) {
      console.log(`  ${item.wordId}  (${item.displayText})  ->  ${item.outcome.replace('exempt_', '')}`);
    }
  }

  const unresolved = plan.items.filter((i) => i.outcome === 'needs_curator');
  if (unresolved.length > 0) {
    console.log(`\n--- a curator must choose (${unresolved.length}) ---`);
    for (const item of unresolved) {
      console.log(`  ${item.wordId}  (${item.displayText})`);
      for (const c of item.candidates ?? []) {
        const etym = c.etymologyNumber ? `etym ${c.etymologyNumber}` : 'no etym number';
        console.log(`       ${c.entryId ?? '(no id - corpus predates 0014)'}  ${c.pos}  [${etym}]  ${c.glosses.join('; ')}`);
      }
    }
  }

  if (!apply) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to write these citations.');
    if (unresolved.length > 0) {
      console.log(`${unresolved.length} word(s) will still need a curator afterwards; --apply does not touch them.`);
    }
  } else {
    console.log('\nApplying...');
    const result = await applyCitationBackfill(pool, plan, appliedBy);
    console.log(`  wrote ${result.applied} citation(s)`);
    if (result.needsCurator.length > 0) {
      console.log(`  left ${result.needsCurator.length} for a curator (untouched, still visible as outstanding)`);
    }
    if (result.failures.length > 0) {
      console.log(`  ${result.failures.length} FAILED:`);
      for (const f of result.failures) console.log(`    ${f.wordId}: ${f.error}`);
      process.exitCode = 1;
    }

    // Verify forward from the database rather than trusting the counters above -
    // the same discipline publishToR2.mjs uses for its uploads.
    const { rows } = await pool.query(
      `select count(*)::int total,
              count(*) filter (where c.word_id is null)::int uncited
       from golden_record g left join upstream_citations c on c.word_id = g.word_id`,
    );
    console.log(`\nVerified: ${rows[0].total - rows[0].uncited}/${rows[0].total} words now cited or explicitly exempt.`);
    if (rows[0].uncited > 0) console.log(`${rows[0].uncited} still uncited - these are the curator decisions above.`);
  }
} finally {
  await pool.end();
}

// migrate.mjs
//
// Minimal migration runner - no framework, just numbered .sql files applied
// in order, tracked in a schema_migrations table. Deliberately lightweight:
// this project already leans away from adding tooling/dependencies it
// doesn't need (see yorubadict's own zero-dependency package.json), and a
// handful of ordered SQL files plus a tracking table is enough for a
// project this size.
//
// Usage: DATABASE_URL=postgres://... node migrate.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      );
    `);

    const { rows: applied } = await client.query('select filename from schema_migrations');
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => !appliedSet.has(f));
    if (!pending.length) {
      console.log('No pending migrations.');
      return;
    }

    for (const filename of pending) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      console.log(`Applying ${filename}...`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [filename]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${filename} failed: ${err.message}`);
      }
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

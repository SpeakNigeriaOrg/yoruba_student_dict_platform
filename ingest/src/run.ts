#!/usr/bin/env node
// run.ts
//
// Orchestrator: load the canonical kaikki-yoruba artifact (latest GitHub
// release by default, or a local file for testing) -> derive senses ->
// synthesize reciprocal component candidates -> write into Postgres, all
// in one transaction.
//
// Usage:
//   node dist/run.js                          # latest kaikki-yoruba release
//   node dist/run.js path/to/entries.json [path/to/metadata.json]

import { deriveSenses } from './deriveSenses.js';
import { getPool, withTransaction } from './db.js';
import { loadEntriesFromFile, loadLatestEntriesAndMetadata, loadMetadataFromFile, type ArtifactMetadata } from './loadEntries.js';
import { synthesizeComponentReciprocals } from './synthesizeComponentReciprocals.js';
import type { CanonicalEntries } from './types.js';
import { writeSensesToPostgres } from './writeToPostgres.js';

async function loadArtifact(entriesPathArg: string | undefined, metadataPathArg: string | undefined): Promise<{
  source: string;
  entries: CanonicalEntries;
  metadata: ArtifactMetadata | null;
}> {
  if (entriesPathArg) {
    const entries = await loadEntriesFromFile(entriesPathArg);
    const metadata = metadataPathArg ? await loadMetadataFromFile(metadataPathArg) : null;
    return { source: entriesPathArg, entries, metadata };
  }
  const { tagName, entries, metadata } = await loadLatestEntriesAndMetadata();
  return { source: `kaikki-yoruba release ${tagName}`, entries, metadata };
}

async function main(): Promise<void> {
  const [entriesPathArg, metadataPathArg] = process.argv.slice(2);

  console.log(`[1/4] Loading canonical artifact${entriesPathArg ? ` from ${entriesPathArg}` : ' (latest kaikki-yoruba release)'} ...`);
  const { source, entries: entriesById, metadata } = await loadArtifact(entriesPathArg, metadataPathArg);
  const entries = Object.values(entriesById);
  console.log(`      loaded ${entries.length} entries from ${source}`);

  console.log('[2/4] Deriving senses (standardForms, glosses, componentCandidates, altOfTargets, index keys) ...');
  const senses = deriveSenses(entries);

  console.log('[3/4] Synthesizing reciprocal component candidates ...');
  synthesizeComponentReciprocals(senses);

  const withComponents = senses.filter((s) => s.componentCandidates.length > 0).length;
  const withAltOf = senses.filter((s) => s.altOfTargets.length > 0).length;
  console.log(`      ${withComponents} senses have component candidates, ${withAltOf} have altOfTargets`);

  console.log('[4/4] Writing to Postgres ...');
  const pool = getPool();
  try {
    const result = await withTransaction(pool, (client) =>
      writeSensesToPostgres(client, senses, {
        sourceDate: metadata?.sourceDate ?? null,
        contentHash: metadata?.contentHash ?? null,
      }),
    );
    console.log(`\nDone. Wrote ${result.senseCount} senses.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

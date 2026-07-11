// writeToPostgres.ts
//
// Writes derived senses into db/migrations/0002_kaikki_lexicon.sql's
// tables: truncate + bulk insert, all in one transaction (matching the
// old pipeline's own "regenerate the whole file wholesale, never patch
// it" behavior - there's no natural stable key across Kaikki
// re-extractions to diff/upsert against).
//
// Rows are inserted via batched multi-row INSERT statements (not
// PostgreSQL's unnest-of-2D-array trick) specifically because
// standard_forms/glosses/alt_of_targets are ragged (different length per
// sense) - a real Postgres multidimensional array must be rectangular, so
// unnest($1::text[][]) would reject ragged data. Each row's array columns
// are bound as their own ordinary 1D array parameter instead; only the
// *rows* are batched together in one INSERT.

import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import type { DerivedKaikkiSense } from './types.js';

const SENSE_BATCH_SIZE = 500; // 11 columns/row * 500 = 5,500 params, well under Postgres's 65,535 limit
const FLAT_BATCH_SIZE = 2000; // 2-4 columns/row

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function insertSenses(client: Queryable, senses: DerivedKaikkiSense[], senseIds: string[]): Promise<void> {
  const rows = senses.map((sense, i) => ({ senseId: senseIds[i], sense }));
  for (const batch of chunk(rows, SENSE_BATCH_SIZE)) {
    const columnsPerRow = 11;
    const placeholders: string[] = [];
    const values: unknown[] = [];
    batch.forEach(({ senseId, sense }, i) => {
      const base = i * columnsPerRow;
      const p = Array.from({ length: columnsPerRow }, (_, j) => `$${base + j + 1}`);
      placeholders.push(`(${p.join(', ')})`);
      values.push(
        senseId,
        sense.pos,
        sense.etymologyNumber,
        sense.headword,
        sense.canonicalForm.value,
        sense.canonicalForm.inferenceMethod,
        sense.canonicalForm.confidence,
        sense.canonicalForm.originalValue,
        sense.standardForms,
        sense.glosses,
        sense.altOfTargets,
      );
    });
    await client.query(
      `insert into kaikki_senses
         (sense_id, pos, etymology_number, headword, canonical_value, canonical_inference_method,
          canonical_confidence, canonical_original_value, standard_forms, glosses, alt_of_targets)
       values ${placeholders.join(', ')}`,
      values,
    );
  }
}

async function insertSenseKeys(client: Queryable, senses: DerivedKaikkiSense[], senseIds: string[]): Promise<void> {
  const rows: Array<{ senseId: string; key: string }> = [];
  senses.forEach((sense, i) => {
    for (const key of sense.indexKeys) {
      rows.push({ senseId: senseIds[i], key });
    }
  });
  for (const batch of chunk(rows, FLAT_BATCH_SIZE)) {
    const placeholders: string[] = [];
    const values: unknown[] = [];
    batch.forEach((row, i) => {
      const base = i * 2;
      placeholders.push(`($${base + 1}, $${base + 2})`);
      values.push(row.senseId, row.key);
    });
    await client.query(
      `insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ${placeholders.join(', ')}`,
      values,
    );
  }
}

async function insertComponentCandidates(client: Queryable, senses: DerivedKaikkiSense[], senseIds: string[]): Promise<void> {
  const rows: Array<{ senseId: string; position: number; form: string; provenance: string }> = [];
  senses.forEach((sense, i) => {
    sense.componentCandidates.forEach((c, position) => {
      rows.push({ senseId: senseIds[i], position, form: c.form, provenance: c.provenance });
    });
  });
  for (const batch of chunk(rows, FLAT_BATCH_SIZE)) {
    const placeholders: string[] = [];
    const values: unknown[] = [];
    batch.forEach((row, i) => {
      const base = i * 4;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(row.senseId, row.position, row.form, row.provenance);
    });
    await client.query(
      `insert into kaikki_component_candidates (sense_id, position, form, provenance) values ${placeholders.join(', ')}`,
      values,
    );
  }
}

async function insertUsedInCandidates(client: Queryable, senses: DerivedKaikkiSense[], senseIds: string[]): Promise<void> {
  const rows: Array<{ senseId: string; position: number; form: string; provenance: string }> = [];
  senses.forEach((sense, i) => {
    sense.usedInCandidates.forEach((c, position) => {
      rows.push({ senseId: senseIds[i], position, form: c.form, provenance: c.provenance });
    });
  });
  for (const batch of chunk(rows, FLAT_BATCH_SIZE)) {
    const placeholders: string[] = [];
    const values: unknown[] = [];
    batch.forEach((row, i) => {
      const base = i * 4;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(row.senseId, row.position, row.form, row.provenance);
    });
    await client.query(
      `insert into kaikki_used_in_candidates (sense_id, position, form, provenance) values ${placeholders.join(', ')}`,
      values,
    );
  }
}

export interface IngestionRunMetadata {
  sourceDate: string | null;
  contentHash: string | null;
}

export interface WriteResult {
  senseCount: number;
}

export async function writeSensesToPostgres(
  client: Queryable,
  senses: DerivedKaikkiSense[],
  runMetadata: IngestionRunMetadata,
): Promise<WriteResult> {
  await client.query('truncate table kaikki_senses cascade');

  const senseIds = senses.map(() => randomUUID());
  await insertSenses(client, senses, senseIds);
  await insertSenseKeys(client, senses, senseIds);
  await insertComponentCandidates(client, senses, senseIds);
  await insertUsedInCandidates(client, senses, senseIds);

  await client.query(
    'insert into kaikki_ingestion_runs (source_date, sense_count, content_hash) values ($1, $2, $3)',
    [runMetadata.sourceDate, senses.length, runMetadata.contentHash],
  );

  return { senseCount: senses.length };
}

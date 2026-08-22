import { afterAll, describe, expect, it } from 'vitest';
import { getTestPool } from '../testSupport.js';
import { assertWordIdReferencesKnown, WORD_ID_COLUMNS } from './wordIdReferences.js';

const pool = getTestPool();

afterAll(async () => {
  await pool.end();
});

// These two are the drift alarm the rename and the delete both rely on. They read the real
// schema rather than a fixture on purpose: the failure they exist to catch is a migration
// that adds or moves a word_id column without anyone updating WORD_ID_COLUMNS, and a fixture
// would be updated by the same hand that forgot.
describe('the word_id reference inventory', () => {
  it('covers every foreign key the database actually has into golden_record(word_id)', async () => {
    await expect(assertWordIdReferencesKnown(pool)).resolves.toBeUndefined();
  });

  it('names only columns that exist - a dropped table would fail the rename mid-transaction', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const existing = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = WORD_ID_COLUMNS.map((c) => `${c.table}.${c.column}`).filter((name) => !existing.has(name));
    expect(missing).toEqual([]);
  });

  it('marks exactly one column as blocking deletion - the reverse component index', () => {
    const blocking = WORD_ID_COLUMNS.filter((c) => c.blocksDeletion);
    expect(blocking).toEqual([
      { table: 'golden_record_components', column: 'component_word_id', label: 'entries built from this word', blocksDeletion: true },
    ]);
  });
});

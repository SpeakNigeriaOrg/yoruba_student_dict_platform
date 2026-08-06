import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { createWord, WordIdAlreadyExistsError } from './createWord.js';
import { EntryIdNotCitableError, EntryIdNotInCorpusError } from './upstreamCitations.js';

const NS = 'testcw_';
const ENTRY_NS = 'testcw-entry-';
const CITED = `${ENTRY_NS}epo`;
const pool = getTestPool();
let curatorUserId: string;

/** Most cases below only care about the golden_record insert, so they cite the
 * exempt branch - it needs no corpus fixture and keeps those tests about the
 * thing they are testing. The citation itself is exercised deliberately in the
 * 'upstream citation' block. */
const EXEMPT = { exemptReason: 'test word, no upstream entry' } as const;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
  await insertTestKaikkiSense(pool, {
    entryId: CITED,
    headword: 'epo',
    canonicalValue: 'epo',
    pos: 'noun',
    etymologyNumber: '1',
    etymologyText: 'Inherited.',
    glosses: ['oil', 'palm oil'],
  });
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

describe('createWord', () => {
  it('inserts a new atomic word with zero golden_record_components rows', async () => {
    await createWord(
      pool,
      { wordId: `${NS}epo_oil`, displayText: 'epo', syllables: ['e', 'po'], definition: 'oil', citation: EXEMPT },
      curatorUserId,
    );

    const word = await pool.query(
      'select display_text, syllables, definition, entry_type from golden_record where word_id = $1',
      [`${NS}epo_oil`],
    );
    expect(word.rows[0]).toEqual({ display_text: 'epo', syllables: ['e', 'po'], definition: 'oil', entry_type: null });

    const components = await pool.query('select 1 from golden_record_components where word_id = $1', [`${NS}epo_oil`]);
    expect(components.rowCount).toBe(0);
  });

  it('rejects a word_id that already exists', async () => {
    await createWord(pool, { wordId: `${NS}dup_word`, displayText: 'x', syllables: ['x'], citation: EXEMPT }, curatorUserId);
    await expect(
      createWord(pool, { wordId: `${NS}dup_word`, displayText: 'y', syllables: ['y'], citation: EXEMPT }, curatorUserId),
    ).rejects.toThrow(WordIdAlreadyExistsError);
  });

  it('defaults definition to null when not provided', async () => {
    await createWord(pool, { wordId: `${NS}no_def`, displayText: 'x', syllables: ['x'], citation: EXEMPT }, curatorUserId);
    const word = await pool.query<{ definition: string | null }>(
      'select definition from golden_record where word_id = $1',
      [`${NS}no_def`],
    );
    expect(word.rows[0].definition).toBeNull();
  });
});

describe('createWord: the upstream citation', () => {
  it('records the cited etymology and pins what it said, with no client-supplied content', async () => {
    const wordId = `${NS}cited_epo`;
    await createWord(
      pool,
      { wordId, displayText: 'epo', syllables: ['e', 'po'], citation: { entryId: CITED } },
      curatorUserId,
    );

    const { rows } = await pool.query<{
      entry_id: string | null;
      exempt_reason: string | null;
      pin: Record<string, unknown>;
      pinned_by: string | null;
    }>('select entry_id, exempt_reason, pin, pinned_by from upstream_citations where word_id = $1', [wordId]);

    expect(rows[0].entry_id).toBe(CITED);
    expect(rows[0].exempt_reason).toBeNull();
    expect(rows[0].pinned_by).toBe(curatorUserId);
    // The pin is the server's copy of its own corpus, taken at this moment.
    expect(rows[0].pin).toEqual({
      etymologyNumber: '1',
      pos: 'noun',
      canonicalForm: 'epo',
      glosses: ['oil', 'palm oil'],
      etymologyText: 'Inherited.',
    });
  });

  it('attributes the pin to a corpus build, so a citation is traceable to a version', async () => {
    const wordId = `${NS}run_attributed`;
    await createWord(pool, { wordId, displayText: 'epo', syllables: ['epo'], citation: { entryId: CITED } }, curatorUserId);

    const { rows } = await pool.query<{ pinned_run_id: string | null; latest: string | null }>(
      `select c.pinned_run_id,
              (select run_id::text from kaikki_ingestion_runs order by ingested_at desc limit 1) as latest
       from upstream_citations c where c.word_id = $1`,
      [wordId],
    );
    // Null only when the runs log has been pruned - that table is observability,
    // not load-bearing, so it must never be the reason a write fails.
    expect(rows[0].pinned_run_id).toBe(rows[0].latest);
  });

  it('records an exemption as an explicit reason, never as a blank', async () => {
    const wordId = `${NS}exempt_word`;
    await createWord(
      pool,
      { wordId, displayText: 'rédíò', syllables: ['ré', 'dí', 'ò'], citation: { exemptReason: 'loanword, no Wiktionary entry' } },
      curatorUserId,
    );

    const { rows } = await pool.query<{ entry_id: string | null; exempt_reason: string | null }>(
      'select entry_id, exempt_reason from upstream_citations where word_id = $1',
      [wordId],
    );
    expect(rows[0]).toEqual({ entry_id: null, exempt_reason: 'loanword, no Wiktionary entry' });
  });

  it('refuses an entry_id absent from the corpus, and leaves NO word behind', async () => {
    const wordId = `${NS}bad_citation`;
    await expect(
      createWord(pool, { wordId, displayText: 'x', syllables: ['x'], citation: { entryId: `${ENTRY_NS}nonexistent` } }, curatorUserId),
    ).rejects.toThrow(EntryIdNotInCorpusError);

    // The atomicity that matters: a word created with a bad citation would be
    // permanently unrepairable, since identity cannot be recovered from spelling.
    const word = await pool.query('select 1 from golden_record where word_id = $1', [wordId]);
    expect(word.rowCount).toBe(0);
  });

  it("refuses kaikki-yoruba's generated- fallback id, which looks stable but tracks ingest order", async () => {
    const wordId = `${NS}generated_citation`;
    await expect(
      createWord(pool, { wordId, displayText: 'x', syllables: ['x'], citation: { entryId: 'generated-epo-noun-12' } }, curatorUserId),
    ).rejects.toThrow(EntryIdNotCitableError);
    const word = await pool.query('select 1 from golden_record where word_id = $1', [wordId]);
    expect(word.rowCount).toBe(0);
  });

  it('rolls the word back too when the citation write fails - one transaction, not two', async () => {
    const wordId = `${NS}atomic_check`;
    await expect(
      createWord(pool, { wordId, displayText: 'x', syllables: ['x'], citation: { exemptReason: '   ' } }, curatorUserId),
    ).rejects.toThrow();
    const word = await pool.query('select 1 from golden_record where word_id = $1', [wordId]);
    expect(word.rowCount).toBe(0);
  });

  it('re-pinning an existing word updates in place rather than failing - drift re-pin is a normal action', async () => {
    const wordId = `${NS}repin`;
    await createWord(pool, { wordId, displayText: 'epo', syllables: ['epo'], citation: { entryId: CITED } }, curatorUserId);

    const { writeCitationInTransaction } = await import('./upstreamCitations.js');
    await writeCitationInTransaction(pool, wordId, { exemptReason: 'reclassified as having no upstream entry' }, curatorUserId);

    const { rows } = await pool.query<{ entry_id: string | null; exempt_reason: string | null }>(
      'select entry_id, exempt_reason from upstream_citations where word_id = $1',
      [wordId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ entry_id: null, exempt_reason: 'reclassified as having no upstream entry' });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { ComponentsNotFoundError, createWord, WordIdAlreadyExistsError } from './createWord.js';
import { EntryIdNotCitableError, EntryIdNotInCorpusError } from './upstreamCitations.js';

const NS = 'testcw_';
const ENTRY_NS = 'testcw-entry-';
const CITED = `${ENTRY_NS}epo`;
/** 0017 makes an etymology the identity of at most ONE word, so every test that creates a word citing
 * an etymology needs its own. Sharing one `CITED` across cases used to work only because nothing
 * enforced the invariant the whole citation model is built on. */
const CITED_ATTRIBUTED = `${ENTRY_NS}attributed`;
const CITED_REPIN = `${ENTRY_NS}repin`;
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
  for (const entryId of [CITED_ATTRIBUTED, CITED_REPIN]) {
    await insertTestKaikkiSense(pool, {
      entryId,
      headword: 'epo',
      canonicalValue: 'epo',
      pos: 'noun',
      etymologyNumber: '1',
      etymologyText: 'Inherited.',
      glosses: ['oil', 'palm oil'],
    });
  }
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

describe('createWord: the optional decomposition', () => {
  it('records the components a word was given, in order', async () => {
    // A compound of two words the dictionary already holds. Both must exist first - the FK is the
    // real enforcement and the picker only ever offers committed words.
    for (const [id, text] of [[`${NS}oju_face`, 'ojú'], [`${NS}ile_house`, 'ilé']]) {
      await createWord(pool, { wordId: id, displayText: text, syllables: [text], citation: EXEMPT }, curatorUserId);
    }

    await createWord(
      pool,
      {
        wordId: `${NS}ojule_doorway`,
        displayText: 'ojúlé',
        syllables: ['o', 'ju', 'le'],
        citation: EXEMPT,
        components: [`${NS}oju_face`, `${NS}ile_house`],
      },
      curatorUserId,
    );

    const rows = await pool.query<{ component_position: number; component_word_id: string }>(
      'select component_position, component_word_id from golden_record_components where word_id = $1 order by component_position',
      [`${NS}ojule_doorway`],
    );
    expect(rows.rows).toEqual([
      { component_position: 0, component_word_id: `${NS}oju_face` },
      { component_position: 1, component_word_id: `${NS}ile_house` },
    ]);

    // Still a WORD, not a phrase: entry_type is what separates the two, and having components is
    // not what makes something a phrase.
    const word = await pool.query<{ entry_type: string | null }>(
      'select entry_type from golden_record where word_id = $1',
      [`${NS}ojule_doorway`],
    );
    expect(word.rows[0].entry_type).toBeNull();
  });

  it('leaves the etymology axis undecided, so the claim still goes to review', async () => {
    // The point of the field is to capture what the person adding the word knows, not to skip the
    // check. A decision row here would take the word straight out of the review queue.
    await createWord(pool, { wordId: `${NS}part_one`, displayText: 'a', syllables: ['a'], citation: EXEMPT }, curatorUserId);
    await createWord(
      pool,
      {
        wordId: `${NS}undecided_compound`,
        displayText: 'ab',
        syllables: ['ab'],
        citation: EXEMPT,
        components: [`${NS}part_one`],
      },
      curatorUserId,
    );

    const decisions = await pool.query(
      "select 1 from word_decisions where word_id = $1 and axis = 'etymology'",
      [`${NS}undecided_compound`],
    );
    expect(decisions.rowCount).toBe(0);
  });

  it('refuses a component that is not in the dictionary, naming it', async () => {
    await expect(
      createWord(
        pool,
        {
          wordId: `${NS}bad_component`,
          displayText: 'x',
          syllables: ['x'],
          citation: EXEMPT,
          components: [`${NS}does_not_exist`],
        },
        curatorUserId,
      ),
    ).rejects.toThrow(ComponentsNotFoundError);

    // And the word itself is not left behind: one transaction, so a rejected component list takes
    // the whole create with it.
    const word = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}bad_component`]);
    expect(word.rowCount).toBe(0);
  });

  it('allows the same word twice, which is what a reduplication is', async () => {
    await createWord(pool, { wordId: `${NS}meji_two`, displayText: 'méjì', syllables: ['me', 'ji'], citation: EXEMPT }, curatorUserId);
    await createWord(
      pool,
      {
        wordId: `${NS}mejimeji_pairs`,
        displayText: 'méjìméjì',
        syllables: ['me', 'ji', 'me', 'ji'],
        citation: EXEMPT,
        components: [`${NS}meji_two`, `${NS}meji_two`],
      },
      curatorUserId,
    );

    const rows = await pool.query(
      'select component_position from golden_record_components where word_id = $1 order by component_position',
      [`${NS}mejimeji_pairs`],
    );
    expect(rows.rows).toEqual([{ component_position: 0 }, { component_position: 1 }]);
  });

  it('writes nothing when the list is omitted or empty, which is the ordinary word', async () => {
    await createWord(pool, { wordId: `${NS}empty_list`, displayText: 'x', syllables: ['x'], citation: EXEMPT, components: [] }, curatorUserId);
    const rows = await pool.query('select 1 from golden_record_components where word_id = $1', [`${NS}empty_list`]);
    expect(rows.rowCount).toBe(0);
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
    await createWord(pool, { wordId, displayText: 'epo', syllables: ['epo'], citation: { entryId: CITED_ATTRIBUTED } }, curatorUserId);

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
    await createWord(pool, { wordId, displayText: 'epo', syllables: ['epo'], citation: { entryId: CITED_REPIN } }, curatorUserId);

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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { ComponentsNotFoundError, createPhrase, NoComponentsError, WordIdAlreadyExistsError } from './createPhrase.js';

const NS = 'testcp_';
const ENTRY_NS = 'testcp-entry-';
const pool = getTestPool();
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
  await pool.query(
    "insert into golden_record (word_id, display_text, syllables) values ($1, 'a', array['a']), ($2, 'b', array['b'])",
    [`${NS}comp_a`, `${NS}comp_b`],
  );
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

describe('createPhrase', () => {
  it('inserts a phrase with its components in order', async () => {
    await createPhrase(
      pool,
      { wordId: `${NS}ab_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
      curatorUserId,
    );

    const word = await pool.query<{ entry_type: string }>('select entry_type from golden_record where word_id = $1', [
      `${NS}ab_phrase`,
    ]);
    expect(word.rows[0].entry_type).toBe('phrase');

    const components = await pool.query<{ component_word_id: string }>(
      'select component_word_id from golden_record_components where word_id = $1 order by component_position',
      [`${NS}ab_phrase`],
    );
    expect(components.rows.map((r) => r.component_word_id)).toEqual([`${NS}comp_a`, `${NS}comp_b`]);
  });

  it('stores the student definition, which this handler used to have no parameter for', async () => {
    // Every phrase created here landed with definition null - the insert did not name the column -
    // so a phrase reached students as an entry with no meaning attached, and the only repair was the
    // entry axis on the finished record. Distinct from english_gloss: same wording often, two
    // audiences always (0018).
    await createPhrase(
      pool,
      {
        wordId: `${NS}defined_phrase`,
        displayText: 'a b',
        syllables: ['a', 'b'],
        components: [`${NS}comp_a`],
        definition: 'the sky',
        englishGloss: 'the sky, the firmament',
      },
      curatorUserId,
    );

    const { rows } = await pool.query<{ definition: string | null; english_gloss: string | null }>(
      'select definition, english_gloss from golden_record where word_id = $1',
      [`${NS}defined_phrase`],
    );
    expect(rows[0]).toEqual({ definition: 'the sky', english_gloss: 'the sky, the firmament' });
  });

  it('leaves the definition null when none is given, rather than inventing one', async () => {
    await createPhrase(
      pool,
      { wordId: `${NS}undefined_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`] },
      curatorUserId,
    );
    const { rows } = await pool.query<{ definition: string | null }>(
      'select definition from golden_record where word_id = $1',
      [`${NS}undefined_phrase`],
    );
    expect(rows[0].definition).toBeNull();
  });

  it('rejects a phrase with zero components', async () => {
    await expect(
      createPhrase(pool, { wordId: `${NS}empty_phrase`, displayText: 'x', syllables: ['x'], components: [] }, curatorUserId),
    ).rejects.toThrow(NoComponentsError);
  });

  it('rejects a component word_id that does not exist, and writes nothing (the transaction rolls back)', async () => {
    await expect(
      createPhrase(
        pool,
        {
          wordId: `${NS}bad_phrase`,
          displayText: 'x',
          syllables: ['x'],
          components: [`${NS}comp_a`, `${NS}nonexistent`],
        },
        curatorUserId,
      ),
    ).rejects.toThrow(ComponentsNotFoundError);

    const word = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}bad_phrase`]);
    expect(word.rowCount).toBe(0);
  });

  it('rejects a word_id that already exists', async () => {
    await createPhrase(
      pool,
      { wordId: `${NS}dup_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
      curatorUserId,
    );
    await expect(
      createPhrase(
        pool,
        { wordId: `${NS}dup_phrase`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
        curatorUserId,
      ),
    ).rejects.toThrow(WordIdAlreadyExistsError);
  });
});

// ---------------------------------------------------------------------------
// A phrase may cite its OWN etymology
// ---------------------------------------------------------------------------
// It could not, at any layer: no field on the input, the wire field was silently dropped, the
// contribution edge threw "a phrase cannot cite an etymology - its components do", and a hardcoded
// exemption was written in the same transaction. The reasoning holds for a locally composed phrase and
// fails for one Wiktionary has its own entry for - 480 of 6272 corpus etymologies are multi-word, and
// "hail the king" is not the sum of its words. Discarding that entry_id threw away what 0017 had just
// made the identity.

describe('a phrase and its own etymology', () => {
  let seq = 0;
  async function etymology(): Promise<string> {
    seq += 1;
    const entryId = `${ENTRY_NS}e${seq}`;
    await insertTestKaikkiSense(pool, {
      entryId,
      headword: 'a b',
      canonicalValue: 'a b',
      glosses: ['a composed meaning'],
    });
    return entryId;
  }

  const citationOf = async (wordId: string) =>
    (
      await pool.query<{ entry_id: string | null; exempt_reason: string | null }>(
        'select entry_id, exempt_reason from upstream_citations where word_id = $1',
        [wordId],
      )
    ).rows[0];

  it('records the cited etymology instead of the by-nature exemption', async () => {
    const entryId = await etymology();
    const wordId = `${NS}cited_phrase`;
    await createPhrase(
      pool,
      { wordId, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`], citation: { entryId } },
      curatorUserId,
    );

    expect(await citationOf(wordId)).toEqual({ entry_id: entryId, exempt_reason: null });
  });

  it('still exempts a phrase with no citation - absence is the composed case, not an omission', async () => {
    const wordId = `${NS}uncited_phrase`;
    await createPhrase(
      pool,
      { wordId, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`, `${NS}comp_b`] },
      curatorUserId,
    );

    const row = await citationOf(wordId);
    expect(row.entry_id).toBeNull();
    expect(row.exempt_reason).toContain('composed phrase');
  });

  it('is covered by 0017 - a second entry cannot claim the phrase etymology', async () => {
    // One etymology, one entry, whatever its shape. Worth asserting because the phrase path bypassed
    // citations entirely before, so it was previously outside this invariant.
    const { EntryAlreadyCitedError } = await import('./upstreamCitations.js');
    const entryId = await etymology();
    await createPhrase(
      pool,
      { wordId: `${NS}first_claim`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_a`], citation: { entryId } },
      curatorUserId,
    );

    await expect(
      createPhrase(
        pool,
        { wordId: `${NS}second_claim`, displayText: 'a b', syllables: ['a', 'b'], components: [`${NS}comp_b`], citation: { entryId } },
        curatorUserId,
      ),
    ).rejects.toThrow(EntryAlreadyCitedError);
    // And the whole transaction rolled back, so no half-made phrase is left.
    const left = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}second_claim`]);
    expect(left.rowCount).toBe(0);
  });

  it('allows a REPEATED component, which is what a reduplication is', async () => {
    // `méjì méjì` is two positions holding one word. component_position is the primary key, so the
    // schema always permitted this; only the client de-duplicated.
    const wordId = `${NS}redup`;
    await createPhrase(
      pool,
      { wordId, displayText: 'a a', syllables: ['a', 'a'], components: [`${NS}comp_a`, `${NS}comp_a`] },
      curatorUserId,
    );

    const { rows } = await pool.query<{ component_position: number; component_word_id: string }>(
      'select component_position, component_word_id from golden_record_components where word_id = $1 order by component_position',
      [wordId],
    );
    expect(rows).toEqual([
      { component_position: 0, component_word_id: `${NS}comp_a` },
      { component_position: 1, component_word_id: `${NS}comp_a` },
    ]);
  });
});

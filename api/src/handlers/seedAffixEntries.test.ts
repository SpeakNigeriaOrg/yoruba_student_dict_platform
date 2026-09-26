// Seeding affixes: which forms are planned, how they are cited or exempted, and that re-running it
// changes nothing. Uses its own made-up affixes (zz-, -qq-) so it neither depends on nor disturbs
// whatever real corpus the test database holds; apply is run on the test's own items only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { applyAffixSeed, EXEMPT_REASON, planAffixSeed } from './seedAffixEntries.js';

const ENTRY_NS = 'testseed-entry-';
const pool = getTestPool();
let curator: string;

async function cleanUp(): Promise<void> {
  await pool.query("delete from golden_record where display_text in ('zz-', '-qq-', 'zzword')");
  await cleanUpTestData(pool, 'testseed_');
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
}

beforeAll(async () => {
  await cleanUp();
  curator = (
    await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ('testseed_curator@example.com', 'c', 'curator') returning user_id",
    )
  ).rows[0].user_id;
  // Wiktionary's own entry for zz-, and a word whose etymology uses zz- and -qq- (no entry).
  await insertTestKaikkiSense(pool, {
    entryId: `${ENTRY_NS}zz`,
    headword: 'zz-',
    canonicalValue: 'zz-',
    pos: 'prefix',
    glosses: ['test prefix meaning'],
  });
  await insertTestKaikkiSense(pool, { entryId: `${ENTRY_NS}word`, headword: 'zzword', canonicalValue: 'zzword', glosses: ['a word'] });
  const sense = await pool.query<{ sense_id: string }>('select sense_id from kaikki_senses where entry_id = $1', [`${ENTRY_NS}word`]);
  for (const [position, form, gloss] of [
    [0, 'zz-', 'test prefix meaning'],
    [1, '-qq-', 'test interfix meaning'],
  ] as const) {
    await pool.query(
      `insert into kaikki_component_candidates (sense_id, position, form, provenance, gloss) values ($1, $2, $3, 'etymology_template', $4)`,
      [sense.rows[0].sense_id, position, form, gloss],
    );
  }
});

afterAll(async () => {
  await cleanUp();
  await pool.end();
});

describe('seedAffixEntries', () => {
  it('plans a cited entry for an affix Wiktionary has, and an exempt one for an affix it lacks', async () => {
    const plan = await planAffixSeed(pool);
    const zz = plan.planned.find((i) => i.displayText === 'zz-');
    const qq = plan.planned.find((i) => i.displayText === '-qq-');
    expect(zz).toMatchObject({ kind: 'cited', pos: 'prefix', entryId: `${ENTRY_NS}zz`, gloss: 'test prefix meaning', uses: 1 });
    expect(qq).toMatchObject({ kind: 'exempt', pos: 'interfix', gloss: 'test interfix meaning', uses: 1 });
  });

  it('creates them as not-standalone entries with their author\'s vote, and a re-plan skips them', async () => {
    const plan = await planAffixSeed(pool);
    const mine = { ...plan, planned: plan.planned.filter((i) => ['zz-', '-qq-'].includes(i.displayText)) };
    const result = await applyAffixSeed(pool, mine, curator);
    expect(result.failed).toEqual([]);
    expect(result.written).toBe(2);

    const rows = await pool.query<{ display_text: string; only_in_derived_terms: boolean; entry_id: string | null; exempt_reason: string | null; english_gloss: string | null }>(
      `select g.display_text, g.only_in_derived_terms, c.entry_id, c.exempt_reason, g.english_gloss
         from golden_record g join upstream_citations c on c.word_id = g.word_id
        where g.display_text in ('zz-', '-qq-') order by g.display_text`,
    );
    expect(rows.rows).toEqual([
      { display_text: '-qq-', only_in_derived_terms: true, entry_id: null, exempt_reason: EXEMPT_REASON, english_gloss: 'test interfix meaning' },
      { display_text: 'zz-', only_in_derived_terms: true, entry_id: `${ENTRY_NS}zz`, exempt_reason: null, english_gloss: null },
    ]);
    const votes = await pool.query(
      "select 1 from contributions n join golden_record g on g.word_id = n.word_id where g.display_text in ('zz-', '-qq-') and n.submitted_by = $1",
      [curator],
    );
    expect(votes.rowCount).toBe(2);

    const again = await planAffixSeed(pool);
    expect(again.planned.filter((i) => ['zz-', '-qq-'].includes(i.displayText))).toEqual([]);
  });
});

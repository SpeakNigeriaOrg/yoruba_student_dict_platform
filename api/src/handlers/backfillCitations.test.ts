import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { applyCitationBackfill, planCitationBackfill, type BackfillPlan } from './backfillCitations.js';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';

const NS = 'testbf_';
const ENTRY_NS = 'testbf-entry-';
const pool = getTestPool();
let curatorUserId: string;

/** kaikki_sense_keys is what diagnoseEntry looks a word up by, so a fixture
 * etymology is only findable once it is keyed. Mirrors what ingest/ does. */
async function keySense(entryId: string, form: string): Promise<void> {
  await pool.query(
    `insert into kaikki_sense_keys (sense_id, orthography_insensitive_key)
     select sense_id, $2 from kaikki_senses where entry_id = $1`,
    [entryId, orthographyInsensitiveForm(form)],
  );
}

async function addWord(wordId: string, displayText: string, syllables: string[]): Promise<void> {
  await pool.query(
    'insert into golden_record (word_id, display_text, syllables, updated_by) values ($1, $2, $3, $4)',
    [wordId, displayText, syllables, curatorUserId],
  );
}

function itemFor(plan: BackfillPlan, wordId: string) {
  const item = plan.items.find((i) => i.wordId === wordId);
  expect(item, `no plan item for ${wordId}`).toBeDefined();
  return item!;
}

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;

  // One unambiguous etymology.
  await insertTestKaikkiSense(pool, {
    entryId: `${ENTRY_NS}solo`,
    headword: 'zzqsolo',
    canonicalValue: 'zzqsolo',
    pos: 'noun',
    etymologyNumber: '1',
    glosses: ['a solo test thing'],
  });
  await keySense(`${ENTRY_NS}solo`, 'zzqsolo');

  // Three etymologies sharing one spelling - the `kọ́` shape.
  for (const [n, pos, gloss] of [
    ['2', 'verb', 'to build'],
    ['3', 'particle', 'a negation particle'],
    ['4', 'verb', 'to hang'],
  ] as const) {
    await insertTestKaikkiSense(pool, {
      entryId: `${ENTRY_NS}amb${n}`,
      headword: 'zzqamb',
      canonicalValue: 'zzqamb',
      pos,
      etymologyNumber: n,
      glosses: [gloss],
    });
    await keySense(`${ENTRY_NS}amb${n}`, 'zzqamb');
  }

  await addWord(`${NS}zzqsolo_thing`, 'zzqsolo', ['zzq', 'solo']);
  await addWord(`${NS}zzqamb_build`, 'zzqamb', ['zzq', 'amb']);
  await addWord(`${NS}zzqabsent_nothing`, 'zzqabsentword', ['zzq', 'absent']);
  await addWord(`${NS}multi_word`, 'zzq two words', ['zzq', 'two', 'words']);
  await pool.query(
    "insert into golden_record (word_id, display_text, syllables, entry_type, updated_by) values ($1, $2, $3, 'phrase', $4)",
    [`${NS}phrase_thing`, 'zzqsolo zzqsolo', ['zzq', 'solo'], curatorUserId],
  );
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

describe('planCitationBackfill', () => {
  it('auto-links a word whose spelling matches exactly one etymology', async () => {
    const plan = await planCitationBackfill(pool);
    const item = itemFor(plan, `${NS}zzqsolo_thing`);
    expect(item.outcome).toBe('auto_link');
    expect(item.entryId).toBe(`${ENTRY_NS}solo`);
    expect(item.etymologyNumber).toBe('1');
  });

  it('refuses to guess when one spelling maps to several etymologies, and reports the choice', async () => {
    const plan = await planCitationBackfill(pool);
    const item = itemFor(plan, `${NS}zzqamb_build`);
    expect(item.outcome).toBe('needs_curator');
    // The whole point: it hands a person the three options rather than silently
    // taking the first, which is what the old form-based resolution did.
    expect(item.candidates?.map((c) => c.etymologyNumber).sort()).toEqual(['2', '3', '4']);
    expect(item.entryId).toBeUndefined();
  });

  it('exempts a word genuinely absent from the corpus, recording how that was established', async () => {
    const plan = await planCitationBackfill(pool);
    const item = itemFor(plan, `${NS}zzqabsent_nothing`);
    expect(item.outcome).toBe('exempt_absent');
    expect(item.exemptReason).toContain('no Kaikki etymology for this spelling');
  });

  it('exempts phrases and multi-word entries for their own distinct reasons', async () => {
    const plan = await planCitationBackfill(pool);
    expect(itemFor(plan, `${NS}phrase_thing`).outcome).toBe('exempt_phrase');
    expect(itemFor(plan, `${NS}phrase_thing`).exemptReason).toContain('components');
    expect(itemFor(plan, `${NS}multi_word`).outcome).toBe('exempt_multiword');
  });

  it('writes nothing - a dry run must be safe to run against production', async () => {
    const before = await pool.query('select count(*)::int n from upstream_citations');
    await planCitationBackfill(pool);
    const after = await pool.query('select count(*)::int n from upstream_citations');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('counts every word exactly once, so the report cannot silently omit any', async () => {
    const plan = await planCitationBackfill(pool);
    const total = Object.values(plan.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(plan.items.length);
  });
});

describe('applyCitationBackfill', () => {
  it('applies exactly what the plan resolved, and leaves the ambiguous word uncited', async () => {
    const plan = await planCitationBackfill(pool);
    const mine = {
      items: plan.items.filter((i) => i.wordId.startsWith(NS)),
      counts: plan.counts,
    };
    const result = await applyCitationBackfill(pool, mine, curatorUserId);

    expect(result.failures).toEqual([]);
    expect(result.needsCurator).toEqual([`${NS}zzqamb_build`]);

    const cited = await pool.query<{ word_id: string; entry_id: string | null; exempt_reason: string | null }>(
      'select word_id, entry_id, exempt_reason from upstream_citations where word_id like $1 order by word_id',
      [`${NS}%`],
    );
    expect(cited.rows).toEqual([
      { word_id: `${NS}multi_word`, entry_id: null, exempt_reason: expect.stringContaining('multi-word') },
      { word_id: `${NS}phrase_thing`, entry_id: null, exempt_reason: expect.stringContaining('components') },
      { word_id: `${NS}zzqabsent_nothing`, entry_id: null, exempt_reason: expect.stringContaining('no Kaikki etymology') },
      { word_id: `${NS}zzqsolo_thing`, entry_id: `${ENTRY_NS}solo`, exempt_reason: null },
    ]);
    // The word a human still has to settle stays visibly outstanding.
    expect(cited.rows.some((r) => r.word_id === `${NS}zzqamb_build`)).toBe(false);
  });

  it('pins upstream content for the auto-linked word, not just the id', async () => {
    const { rows } = await pool.query<{ pin: Record<string, unknown> }>(
      'select pin from upstream_citations where word_id = $1',
      [`${NS}zzqsolo_thing`],
    );
    expect(rows[0].pin).toMatchObject({ etymologyNumber: '1', pos: 'noun', glosses: ['a solo test thing'] });
  });

  it('is idempotent - a second run reports the words as already cited and changes nothing', async () => {
    const plan = await planCitationBackfill(pool);
    expect(itemFor(plan, `${NS}zzqsolo_thing`).outcome).toBe('already_cited');

    const before = await pool.query<{ pinned_at: Date }>('select pinned_at from upstream_citations where word_id = $1', [
      `${NS}zzqsolo_thing`,
    ]);
    const result = await applyCitationBackfill(pool, { items: plan.items.filter((i) => i.wordId.startsWith(NS)), counts: plan.counts }, curatorUserId);
    expect(result.applied).toBe(0);
    const after = await pool.query<{ pinned_at: Date }>('select pinned_at from upstream_citations where word_id = $1', [
      `${NS}zzqsolo_thing`,
    ]);
    expect(after.rows[0].pinned_at).toEqual(before.rows[0].pinned_at);
  });
});

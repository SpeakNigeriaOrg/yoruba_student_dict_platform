// Each of the four drift states is produced by making a REAL change to the
// corpus a citation points at, rather than by hand-crafting a pin that could not
// arise. The states are only meaningful as answers to "what happened upstream",
// so they are tested by making that thing happen.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPin } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { reconcileUpstream } from './reconcileUpstream.js';
import { writeCitationInTransaction } from './upstreamCitations.js';

const NS = 'testrec_';
const ENTRY_NS = 'testrec-entry-';
const pool = getTestPool();
let curatorUserId: string;

async function addSense(entryId: string, glosses: string[], etymologyNumber = '1'): Promise<void> {
  await insertTestKaikkiSense(pool, {
    entryId,
    headword: 'zzqrec',
    canonicalValue: 'zzqrec',
    pos: 'verb',
    etymologyNumber,
    glosses,
  });
}

async function citedWord(wordId: string, entryId: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    'zzqrec',
    ['zzq', 'rec'],
  ]);
  await writeCitationInTransaction(pool, wordId, { entryId }, curatorUserId);
}

function itemFor(result: Awaited<ReturnType<typeof reconcileUpstream>>, wordId: string) {
  return result.items.find((i) => i.wordId === wordId);
}

beforeAll(async () => {
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
});

beforeEach(async () => {
  await pool.query('delete from golden_record where word_id like $1', [`${NS}%`]);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
});

afterAll(async () => {
  await pool.query('delete from golden_record where word_id like $1', [`${NS}%`]);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('reconcileUpstream', () => {
  it('reports nothing for a citation upstream still agrees with', async () => {
    await addSense(`${ENTRY_NS}a`, ['to walk']);
    await citedWord(`${NS}walk`, `${ENTRY_NS}a`);

    const result = await reconcileUpstream(pool);
    expect(itemFor(result, `${NS}walk`)).toBeUndefined();
    expect(result.counts.unchanged).toBeGreaterThanOrEqual(1);
  });

  it('does NOT report senses being reordered inside one etymology', async () => {
    // The id moves with the first sense, but the etymology means the same thing.
    // Reporting this would send a curator to adjudicate a non-event.
    await addSense(`${ENTRY_NS}b`, ['to build', 'to learn']);
    await citedWord(`${NS}build`, `${ENTRY_NS}b`);

    await pool.query('update kaikki_senses set glosses = $1 where entry_id = $2', [
      ['to learn', 'to build'],
      `${ENTRY_NS}b`,
    ]);

    expect(itemFor(await reconcileUpstream(pool), `${NS}build`)).toBeUndefined();
  });

  it('reports a gloss being reworded under a stable id, with both versions', async () => {
    await addSense(`${ENTRY_NS}c`, ['to walk']);
    await citedWord(`${NS}reworded`, `${ENTRY_NS}c`);

    await pool.query('update kaikki_senses set glosses = $1 where entry_id = $2', [['to stroll'], `${ENTRY_NS}c`]);

    const item = itemFor(await reconcileUpstream(pool), `${NS}reworded`);
    expect(item?.kind).toBe('content_changed');
    // Both sides, so a curator can judge rather than just being told something moved.
    expect(item?.pin.glosses).toEqual(['to walk']);
    expect(item?.current?.glosses).toEqual(['to stroll']);
  });

  it('reports renumbering under a stable id - the drift that motivated citations', async () => {
    await addSense(`${ENTRY_NS}d`, ['to walk'], '2');
    await citedWord(`${NS}renumbered`, `${ENTRY_NS}d`);

    await pool.query("update kaikki_senses set etymology_number = '3' where entry_id = $1", [`${ENTRY_NS}d`]);

    const item = itemFor(await reconcileUpstream(pool), `${NS}renumbered`);
    expect(item?.kind).toBe('content_changed');
    expect(item?.current?.etymologyNumber).toBe('3');
  });

  it('re-identifies content that moved to a new id, and proposes the re-link', async () => {
    // The branch that fires in practice: the id is content-derived, so an upstream
    // edit usually breaks the link loudly instead of leaving a stale pointer.
    await addSense(`${ENTRY_NS}old`, ['to vanish and return']);
    await citedWord(`${NS}moved`, `${ENTRY_NS}old`);

    await pool.query('delete from kaikki_senses where entry_id = $1', [`${ENTRY_NS}old`]);
    await addSense(`${ENTRY_NS}new`, ['to vanish and return']);

    const item = itemFor(await reconcileUpstream(pool), `${NS}moved`);
    expect(item?.kind).toBe('re_identified');
    expect(item?.proposedEntryId).toBe(`${ENTRY_NS}new`);
  });

  it('re-identifies across a sense reorder too, since content is compared as a set', async () => {
    await addSense(`${ENTRY_NS}old2`, ['to build', 'to learn']);
    await citedWord(`${NS}moved2`, `${ENTRY_NS}old2`);

    await pool.query('delete from kaikki_senses where entry_id = $1', [`${ENTRY_NS}old2`]);
    await addSense(`${ENTRY_NS}new2`, ['to learn', 'to build']);

    const item = itemFor(await reconcileUpstream(pool), `${NS}moved2`);
    expect(item?.kind).toBe('re_identified');
    expect(item?.proposedEntryId).toBe(`${ENTRY_NS}new2`);
  });

  it('hard-flags a citation whose etymology is gone with nothing matching it', async () => {
    await addSense(`${ENTRY_NS}gone`, ['a very specific unrepeated meaning']);
    await citedWord(`${NS}gone`, `${ENTRY_NS}gone`);

    await pool.query('delete from kaikki_senses where entry_id = $1', [`${ENTRY_NS}gone`]);

    const item = itemFor(await reconcileUpstream(pool), `${NS}gone`);
    expect(item?.kind).toBe('disappeared');
    expect(item?.proposedEntryId).toBeUndefined();
    // The pin is still the record of what was validated, which is the whole point
    // of having taken it - the word is not left describing nothing.
    expect(item?.pin.glosses).toEqual(['a very specific unrepeated meaning']);
  });

  it('does not check exempt words, and says how many it skipped', async () => {
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      `${NS}exempt`,
      'rédíò',
      ['ré', 'dí', 'ò'],
    ]);
    await writeCitationInTransaction(pool, `${NS}exempt`, { exemptReason: 'loanword' }, curatorUserId);

    const result = await reconcileUpstream(pool);
    expect(itemFor(result, `${NS}exempt`)).toBeUndefined();
    expect(result.exempt).toBeGreaterThanOrEqual(1);
  });

  it('NAMES the exempt words, not just how many there are', async () => {
    // An exempt citation is the durable record that a word awaits a Wiktionary entry - which the
    // volunteer word-request path depends on. A record nobody can find is not a record: this was
    // counted and never listed, so on the day Wiktionary gained the entry there was nothing to
    // act on.
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      `${NS}exemptnamed`,
      'kọ̀mpútà',
      ['kọ̀m', 'pú', 'tà'],
    ]);
    await writeCitationInTransaction(pool, `${NS}exemptnamed`, { exemptReason: 'no Wiktionary entry yet' }, curatorUserId);

    const result = await reconcileUpstream(pool);
    expect(result.exemptItems).toContainEqual({
      wordId: `${NS}exemptnamed`,
      displayText: 'kọ̀mpútà',
      exemptReason: 'no Wiktionary entry yet',
    });
    // And the count stays the length of that list, so the two can never disagree.
    expect(result.exempt).toBe(result.exemptItems.length);
  });

  it('counts uncited words separately, so a clean report is never mistaken for full coverage', async () => {
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      `${NS}uncited`,
      'zzquncited',
      ['zzq'],
    ]);

    const result = await reconcileUpstream(pool);
    expect(result.uncited).toBeGreaterThanOrEqual(1);
    expect(itemFor(result, `${NS}uncited`)).toBeUndefined();
  });

  it('lists only what needs attention - "unchanged" is counted, never listed', async () => {
    await addSense(`${ENTRY_NS}fine`, ['fine']);
    await citedWord(`${NS}fine`, `${ENTRY_NS}fine`);

    const result = await reconcileUpstream(pool);
    expect(result.items.every((i) => i.kind !== 'unchanged')).toBe(true);
  });

  it('is read-only - a report must never modify the citations it reports on', async () => {
    await addSense(`${ENTRY_NS}ro`, ['to walk']);
    await citedWord(`${NS}readonly`, `${ENTRY_NS}ro`);
    await pool.query('update kaikki_senses set glosses = $1 where entry_id = $2', [['changed'], `${ENTRY_NS}ro`]);

    const before = await pool.query('select entry_id, pin, pinned_at from upstream_citations where word_id = $1', [
      `${NS}readonly`,
    ]);
    await reconcileUpstream(pool);
    const after = await pool.query('select entry_id, pin, pinned_at from upstream_citations where word_id = $1', [
      `${NS}readonly`,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('agrees with buildPin about what unchanged means, so the two never drift apart', async () => {
    await addSense(`${ENTRY_NS}agree`, ['x', 'y']);
    await citedWord(`${NS}agree`, `${ENTRY_NS}agree`);

    const { rows } = await pool.query<{ pin: Record<string, unknown> }>(
      'select pin from upstream_citations where word_id = $1',
      [`${NS}agree`],
    );
    const senseRow = await pool.query('select * from kaikki_senses where entry_id = $1', [`${ENTRY_NS}agree`]);
    expect(rows[0].pin).toEqual(
      buildPin({
        entryId: `${ENTRY_NS}agree`,
        pos: senseRow.rows[0].pos,
        etymologyNumber: senseRow.rows[0].etymology_number,
        etymologyText: senseRow.rows[0].etymology_text,
        headword: senseRow.rows[0].headword,
        canonicalForm: {
          value: senseRow.rows[0].canonical_value,
          inferenceMethod: senseRow.rows[0].canonical_inference_method,
          confidence: Number(senseRow.rows[0].canonical_confidence),
          originalValue: senseRow.rows[0].canonical_original_value,
        },
        standardForms: senseRow.rows[0].standard_forms,
        glosses: senseRow.rows[0].glosses,
        altOfTargets: senseRow.rows[0].alt_of_targets,
        componentCandidates: [],
        derivedForms: [],
      }),
    );
  });
});

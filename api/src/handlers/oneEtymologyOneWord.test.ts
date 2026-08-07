// One etymology, one word - enforced, and a request resolved wherever the word comes from.
//
// Two halves of the same fact, both living at writeCitationInTransaction because that is the single
// place where "this etymology is now this word's identity" becomes true:
//
//   negatively - no other word may already hold it (0017)
//   positively - every open request for it is satisfied, so it closes
//
// The second half is the flaw the invariant had all along. Resolution was keyed on the contribution
// ROW: approveContribution closed only the row named in its URL, and adding a word directly closed
// nothing at all. So a curator who satisfied a volunteer's request by adding the word left the request
// standing forever - and if they happened to use its planned word_id, left it permanently
// unapprovable, because approving it would then try to create a word_id that already exists.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { createWord } from './createWord.js';
import { EntryAlreadyCitedError, writeCitationInTransaction } from './upstreamCitations.js';
import { submitContribution } from './submitContribution.js';

const NS = 'testoneety_';
const ENTRY_NS = 'testoneety-entry-';
const pool = getTestPool();
let curator: string;
let ada: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  const mk = async (email: string, role: 'curator' | 'volunteer') =>
    (
      await pool.query<{ user_id: string }>(
        'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
        [`${NS}${email}`, email, role],
      )
    ).rows[0].user_id;
  curator = await mk('curator@example.com', 'curator');
  ada = await mk('ada@example.com', 'volunteer');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

let seq = 0;
/** A fresh etymology per case - the invariant under test forbids sharing one. */
async function etymology(): Promise<string> {
  seq += 1;
  const entryId = `${ENTRY_NS}e${seq}`;
  await insertTestKaikkiSense(pool, { entryId, headword: 'jẹun', canonicalValue: 'jẹun', glosses: ['to eat food'] });
  return entryId;
}

beforeEach(async () => {
  await pool.query('delete from contributions where submitted_by = $1', [ada]);
  await pool.query('delete from golden_record where word_id like $1', [`${NS}%`]);
});

async function request(entryId: string | null, proposedWordId: string): Promise<string> {
  const { contributionId } = await submitContribution(
    pool,
    {
      axis: 'new_entry',
      proposedValue: {
        proposedWordId,
        displayText: 'jẹun',
        syllables: ['jẹ', 'un'],
        type: 'word',
        definition: 'to eat food',
        citation: entryId ? { entryId } : { exemptReason: 'no upstream entry' },
      },
    },
    ada,
  );
  return contributionId;
}

const statusOf = async (contributionId: string): Promise<string> =>
  (await pool.query<{ status: string }>('select status from contributions where contribution_id = $1', [contributionId]))
    .rows[0].status;

describe('an etymology is the identity of at most one word', () => {
  it('refuses a second word citing an etymology another word already holds', async () => {
    const entryId = await etymology();
    await createWord(pool, { wordId: `${NS}first`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator);

    await expect(
      createWord(pool, { wordId: `${NS}second`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator),
    ).rejects.toThrow(EntryAlreadyCitedError);
  });

  it('names the word that holds it, rather than quoting a constraint', async () => {
    const entryId = await etymology();
    await createWord(pool, { wordId: `${NS}holder`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator);
    await expect(
      createWord(pool, { wordId: `${NS}other`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator),
    ).rejects.toThrow(/is already the identity of '.*holder'/);
  });

  it('leaves NO half-made word behind - the refusal rolls back the whole transaction', async () => {
    const entryId = await etymology();
    await createWord(pool, { wordId: `${NS}first`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator);
    await expect(
      createWord(pool, { wordId: `${NS}second`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator),
    ).rejects.toThrow(EntryAlreadyCitedError);

    const word = await pool.query('select 1 from golden_record where word_id = $1', [`${NS}second`]);
    expect(word.rowCount).toBe(0);
  });

  it('lets a word RE-PIN to the etymology it already cites - drift re-pin is a normal curator action', async () => {
    const entryId = await etymology();
    await createWord(pool, { wordId: `${NS}repin`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator);
    await expect(writeCitationInTransaction(pool, `${NS}repin`, { entryId }, curator)).resolves.toBeUndefined();
  });

  it('is enforced by the DATABASE too, not only by the pre-check', async () => {
    // The pre-check exists to produce a good message; the index is what makes the invariant true under
    // concurrency. Asserted directly, because a check that can be bypassed is not a constraint.
    const entryId = await etymology();
    await createWord(pool, { wordId: `${NS}indexed`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator);
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      `${NS}sneaky`,
      'jẹun',
      ['x'],
    ]);
    await expect(
      pool.query(
        `insert into upstream_citations (word_id, entry_id, pin, pinned_by) values ($1, $2, '{}'::jsonb, $3)`,
        [`${NS}sneaky`, entryId, curator],
      ),
    ).rejects.toThrow(/upstream_citations_entry_id_unique/);
  });

  it('still allows MANY exempt words, whose entry_id is null', async () => {
    // NULLs are distinct in a unique index and the predicate excludes them anyway - but "many exempt
    // words coexist" is a requirement of the 0014 model, so it is asserted rather than reasoned about.
    for (const suffix of ['a', 'b', 'c']) {
      await createWord(
        pool,
        { wordId: `${NS}exempt_${suffix}`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { exemptReason: `reason ${suffix}` } },
        curator,
      );
    }
    const { rows } = await pool.query<{ n: string }>(
      'select count(*) as n from upstream_citations where word_id like $1 and entry_id is null',
      [`${NS}exempt%`],
    );
    expect(Number(rows[0].n)).toBe(3);
  });
});

describe('a request resolves wherever the word comes from', () => {
  it('closes the request when a curator adds the word DIRECTLY, not through approval', async () => {
    // The hole this fixes. Nothing about createWord used to touch contributions at all.
    const entryId = await etymology();
    const contributionId = await request(entryId, `${NS}planned`);
    expect(await statusOf(contributionId)).toBe('active');

    await createWord(
      pool,
      { wordId: `${NS}added_by_curator`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } },
      curator,
    );

    expect(await statusOf(contributionId)).toBe('applied');
  });

  it('records who caused it, so an applied request is not anonymous', async () => {
    const entryId = await etymology();
    const contributionId = await request(entryId, `${NS}planned`);
    await createWord(pool, { wordId: `${NS}added`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId } }, curator);

    const { rows } = await pool.query<{ reviewed_by: string | null; reviewed_at: Date | null }>(
      'select reviewed_by, reviewed_at from contributions where contribution_id = $1',
      [contributionId],
    );
    expect(rows[0].reviewed_by).toBe(curator);
    expect(rows[0].reviewed_at).not.toBeNull();
  });

  it('closes a request matched only by its planned word_id - the unapprovable-zombie case', async () => {
    // An exempt request cites no etymology, so the planned id is the only thing that can match. This is
    // also exactly the request that would otherwise be impossible to approve, since approving it would
    // try to create a word_id that now exists.
    const contributionId = await request(null, `${NS}taken_id`);
    await createWord(
      pool,
      { wordId: `${NS}taken_id`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { exemptReason: 'loanword' } },
      curator,
    );
    expect(await statusOf(contributionId)).toBe('applied');
  });

  it('leaves a request for a DIFFERENT etymology alone', async () => {
    const mine = await etymology();
    const theirs = await etymology();
    const untouched = await request(theirs, `${NS}other_planned`);
    await createWord(pool, { wordId: `${NS}mine`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId: mine } }, curator);
    expect(await statusOf(untouched)).toBe('active');
  });

  it('closes SEVERAL requests at once, matching on either key in one statement', async () => {
    // Resolution is set-scoped, not one-row-at-a-time - "resolving it anywhere resolves it everywhere".
    //
    // Note which two rows this can be. 0017 makes two OPEN requests for one etymology impossible, so
    // the reachable pair is: one request citing the etymology being added, and a separate request for a
    // DIFFERENT etymology that happens to have planned the word_id now being taken. The second is the
    // one that used to become permanently unapprovable.
    const mine = await etymology();
    const other = await etymology();
    const byEtymology = await request(mine, `${NS}planned_elsewhere`);
    const byPlannedId = await request(other, `${NS}the_word`);

    await createWord(pool, { wordId: `${NS}the_word`, displayText: 'jẹun', syllables: ['jẹ', 'un'], citation: { entryId: mine } }, curator);

    expect(await statusOf(byEtymology)).toBe('applied');
    expect(await statusOf(byPlannedId)).toBe('applied');
  });
});

describe('a request cannot be opened twice for one etymology', () => {
  it('is refused by the database, so the dedup is a constraint rather than a hope', async () => {
    // resolveOrRequestComponent checks before inserting, but that is a read-then-write and read
    // committed does not serialise it. new_entry takes no part in consensus (it has no fingerprint -
    // the proposal IS the content), so deduplication is not an optimisation here, it is the whole
    // mechanism, and it cannot be left advisory.
    const entryId = await etymology();
    await request(entryId, `${NS}planned_first`);
    await expect(request(entryId, `${NS}planned_second`)).rejects.toThrow(
      /contributions_one_active_request_per_etymology/,
    );
  });

  it('allows a new request once the earlier one is closed - history must not block', async () => {
    const entryId = await etymology();
    const first = await request(entryId, `${NS}planned_first`);
    await pool.query("update contributions set status = 'applied' where contribution_id = $1", [first]);
    await expect(request(entryId, `${NS}planned_again`)).resolves.toBeTruthy();
  });
});

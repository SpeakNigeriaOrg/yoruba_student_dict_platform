// "Is this Wiktionary etymology already someone's identity?" against real Postgres.
//
// This is the question the curator Add Word flow never asked. It compared SPELLINGS instead, which is
// why `jẹun` could be offered as a new word while `jeun_eat` already cited the very etymology on
// offer. The lookup existed on the volunteer path the whole time; these tests cover the one copy both
// paths now use.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from './testSupport.js';
import { findWordCiting, loadEntryClaim, loadEntryClaims, loadIdentityUncomparableWords } from './entryClaims.js';
import { submitContribution } from './handlers/submitContribution.js';

const NS = 'testclaims_';
const ENTRY_NS = 'testclaims-entry-';
const HELD = `${ENTRY_NS}held`;
const WANTED = `${ENTRY_NS}wanted`;
const FREE = `${ENTRY_NS}free`;
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
  for (const entryId of [HELD, WANTED, FREE]) {
    await insertTestKaikkiSense(pool, { entryId, headword: 'jẹun', canonicalValue: 'jẹun', glosses: ['to eat food'] });
  }
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

beforeEach(async () => {
  await pool.query('delete from contributions where submitted_by = $1', [ada]);
  await pool.query('delete from golden_record where word_id like $1', [`${NS}%`]);
});

/** A dictionary word, optionally citing an etymology or exempt from citing one. */
async function addWord(wordId: string, citation: { entryId: string } | { exempt: string } | null): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    'jẹun',
    ['jẹ', 'un'],
  ]);
  if (citation === null) return; // pre-0014 shape: a word with no citation row at all
  const entryId = 'entryId' in citation ? citation.entryId : null;
  const exempt = 'exempt' in citation ? citation.exempt : null;
  await pool.query(
    `insert into upstream_citations (word_id, entry_id, exempt_reason, pin, pinned_by)
     values ($1, $2, $3, '{}'::jsonb, $4)`,
    [wordId, entryId, exempt, curator],
  );
}

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

describe('loadEntryClaims', () => {
  it('reports an etymology a word already cites - the jẹun case, which used to be silent', async () => {
    await addWord(`${NS}jeun_eat`, { entryId: HELD });
    const claims = await loadEntryClaims(pool, [HELD]);
    expect(claims.get(HELD)).toEqual({ status: 'in_dictionary', wordId: `${NS}jeun_eat`, displayText: 'jẹun' });
  });

  it('reports an etymology only REQUESTED, and names the planned id rather than an existing word', async () => {
    const contributionId = await request(WANTED, `${NS}planned`);
    expect(await loadEntryClaim(pool, WANTED)).toEqual({
      status: 'requested',
      wordId: `${NS}planned`,
      displayText: 'jẹun',
      contributionId,
    });
  });

  it('says nothing about a free etymology, so "nobody looked" stays distinguishable from "available"', async () => {
    expect(await loadEntryClaim(pool, FREE)).toBeNull();
  });

  it('prefers the DICTIONARY over a standing request for the same etymology', async () => {
    // The word existing is the stronger fact: the request is satisfied whether or not anyone has
    // closed it, so answering "requested" would send a curator to a queue item for work already done.
    await request(HELD, `${NS}planned`);
    await addWord(`${NS}jeun_eat`, { entryId: HELD });
    expect(await loadEntryClaim(pool, HELD)).toMatchObject({ status: 'in_dictionary', wordId: `${NS}jeun_eat` });
  });

  it('ignores a request that is no longer active - history must not block a new one', async () => {
    const contributionId = await request(WANTED, `${NS}planned`);
    await pool.query("update contributions set status = 'applied' where contribution_id = $1", [contributionId]);
    expect(await loadEntryClaim(pool, WANTED)).toBeNull();
  });

  it('ignores an EXEMPT request, which cites no etymology to be matched on', async () => {
    await request(null, `${NS}planned_exempt`);
    expect(await loadEntryClaim(pool, WANTED)).toBeNull();
  });

  it('answers a whole result set in one go, which is how the search uses it', async () => {
    await addWord(`${NS}jeun_eat`, { entryId: HELD });
    await request(WANTED, `${NS}planned`);
    const claims = await loadEntryClaims(pool, [HELD, WANTED, FREE]);
    expect(claims.get(HELD)?.status).toBe('in_dictionary');
    expect(claims.get(WANTED)?.status).toBe('requested');
    expect(claims.has(FREE)).toBe(false);
  });

  it('returns an empty map for no ids without going to the database', async () => {
    // A search that matched nothing must not pay for two queries.
    let queried = false;
    const spy = { query: async () => { queried = true; return { rows: [], rowCount: 0 }; } };
    expect((await loadEntryClaims(spy as never, [])).size).toBe(0);
    expect(queried).toBe(false);
  });
});

describe('findWordCiting', () => {
  it('names the holder, and is silent for a free etymology', async () => {
    await addWord(`${NS}jeun_eat`, { entryId: HELD });
    expect(await findWordCiting(pool, HELD)).toBe(`${NS}jeun_eat`);
    expect(await findWordCiting(pool, FREE)).toBeNull();
  });

  it('is NOT satisfied by a mere request - a request is a plan, and approving it must not be blocked', async () => {
    await request(WANTED, `${NS}planned`);
    expect(await findWordCiting(pool, WANTED)).toBeNull();
  });
});

describe('loadIdentityUncomparableWords', () => {
  it('finds words with no citation row at all - the pre-0014 population', async () => {
    await addWord(`${NS}legacy`, null);
    const words = await loadIdentityUncomparableWords(pool);
    expect(words.map((w) => w.wordId)).toContain(`${NS}legacy`);
  });

  it('finds EXEMPT words, where there is no etymology to compare by construction', async () => {
    await addWord(`${NS}loanword`, { exempt: 'recent loanword' });
    const words = await loadIdentityUncomparableWords(pool);
    expect(words.map((w) => w.wordId)).toContain(`${NS}loanword`);
  });

  it('EXCLUDES a cited word - it has an authoritative answer, so spelling must not speak for it', async () => {
    // This is the `kọ́` guard. A cited word sharing a spelling with a different etymology is a false
    // positive, and suppressing it is the reason spelling was demoted rather than deleted.
    await addWord(`${NS}jeun_eat`, { entryId: HELD });
    const words = await loadIdentityUncomparableWords(pool);
    expect(words.map((w) => w.wordId)).not.toContain(`${NS}jeun_eat`);
  });

  it('folds the spelling for comparison, since the caller matches against result forms', async () => {
    await addWord(`${NS}loanword`, { exempt: 'recent loanword' });
    const found = (await loadIdentityUncomparableWords(pool)).find((w) => w.wordId === `${NS}loanword`);
    expect(found).toMatchObject({ displayText: 'jẹun', base: 'jeun' });
  });
});

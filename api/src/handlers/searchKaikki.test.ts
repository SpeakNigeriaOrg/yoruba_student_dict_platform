import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { searchKaikkiHandler } from './searchKaikki.js';

const NS = 'testsearchk_';
const pool = getTestPool();
const seededKaikkiSenseIds: string[] = [];

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  if (seededKaikkiSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededKaikkiSenseIds]);
  }
  await pool.end();
});

async function insertKaikkiSense(headword: string, canonicalValue: string, orthographyKey: string, glosses: string[]): Promise<void> {
  const result = await pool.query<{ sense_id: string }>(
    `insert into kaikki_senses
       (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
     values ('noun', $1, $2, 'explicit_canonical_tag', 1.0, $1, $3, $4)
     returning sense_id`,
    [headword, canonicalValue, [canonicalValue], glosses],
  );
  seededKaikkiSenseIds.push(result.rows[0].sense_id);
  await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
    result.rows[0].sense_id,
    orthographyKey,
  ]);
}

describe('searchKaikkiHandler', () => {
  it('finds a real seeded sense by exact Yoruba spelling', async () => {
    await insertKaikkiSense(`${NS}kasu`, `${NS}kásù`, `${NS}kasu`, ['test gloss for search']);

    const results = await searchKaikkiHandler(pool, `${NS}kásù`);

    expect(results.some((r) => r.form === `${NS}kásù`)).toBe(true);
  });

  it('finds a real seeded sense by English gloss keyword', async () => {
    await insertKaikkiSense(`${NS}amotekun`, `${NS}amotekun`, `${NS}amotekun`, ['leopardsearchword']);

    const results = await searchKaikkiHandler(pool, 'leopardsearchword');

    expect(results.some((r) => r.form === `${NS}amotekun`)).toBe(true);
  });

  it('returns an empty array for an empty query', async () => {
    expect(await searchKaikkiHandler(pool, '')).toEqual([]);
  });

  it('returns an empty array when nothing matches', async () => {
    // Avoid ordinary English lexemes such as "test" in this negative query:
    // the local Kaikki corpus legitimately contains those in unrelated glosses.
    expect(await searchKaikkiHandler(pool, 'qzxvnomatchqueryxyz')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reported bug: results said nothing about being already in the dictionary
// ---------------------------------------------------------------------------
// A curator searched, saw fifteen indistinguishable rows, picked `jẹun`, and only then got a warning
// that read "identical spelling" - when in fact `jeun_eat` already cited the very etymology on offer.
// The answer was exact and one query away. These cases pin it at search time, where it belongs.

describe('searchKaikkiHandler reports whether an etymology is already taken', () => {
  const CITED = `${NS}entry-cited`;
  const REQUESTED = `${NS}entry-requested`;
  const FREE = `${NS}entry-free`;
  const SHARED_SPELLING = `${NS}entry-shared`;
  let curator: string;
  let ada: string;

  /** Like insertKaikkiSense above, but with an entry_id - identity needs one. */
  async function insertCitableSense(entryId: string, canonicalValue: string, orthographyKey: string): Promise<void> {
    const result = await pool.query<{ sense_id: string }>(
      `insert into kaikki_senses
         (entry_id, pos, headword, canonical_value, canonical_inference_method, canonical_confidence,
          canonical_original_value, standard_forms, glosses)
       values ($1, 'verb', $2, $2, 'explicit_canonical_tag', 1.0, $2, $3, $4)
       returning sense_id`,
      [entryId, canonicalValue, [canonicalValue], ['to eat foodsearchword']],
    );
    seededKaikkiSenseIds.push(result.rows[0].sense_id);
    await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
      result.rows[0].sense_id,
      orthographyKey,
    ]);
  }

  async function addWord(wordId: string, displayText: string, citation: { entryId: string } | { exempt: string } | null) {
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId,
      displayText,
      ['x'],
    ]);
    if (citation === null) return;
    await pool.query(
      `insert into upstream_citations (word_id, entry_id, exempt_reason, pin, pinned_by)
       values ($1, $2, $3, '{}'::jsonb, $4)`,
      [wordId, 'entryId' in citation ? citation.entryId : null, 'exempt' in citation ? citation.exempt : null, curator],
    );
  }

  beforeAll(async () => {
    const mk = async (email: string, role: 'curator' | 'volunteer') =>
      (
        await pool.query<{ user_id: string }>(
          'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
          [`${NS}${email}`, email, role],
        )
      ).rows[0].user_id;
    curator = await mk('claimcurator@example.com', 'curator');
    ada = await mk('claimada@example.com', 'volunteer');

    await insertCitableSense(CITED, `${NS}jeuncited`, `${NS}jeuncited`);
    await insertCitableSense(REQUESTED, `${NS}jeunrequested`, `${NS}jeunrequested`);
    await insertCitableSense(FREE, `${NS}jeunfree`, `${NS}jeunfree`);
    await insertCitableSense(SHARED_SPELLING, `${NS}jeunshared`, `${NS}jeunshared`);

    await addWord(`${NS}jeun_eat`, `${NS}jeuncited`, { entryId: CITED });
    // An exempt word spelled exactly like a FREE etymology: identity cannot speak for it, so this is
    // the one population where a shared spelling is the best signal available.
    await addWord(`${NS}jeun_loan`, `${NS}jeunshared`, { exempt: 'recent loanword' });

    const { submitContribution } = await import('./submitContribution.js');
    await submitContribution(
      pool,
      {
        axis: 'new_entry',
        proposedValue: {
          proposedWordId: `${NS}planned_word`,
          displayText: `${NS}jeunrequested`,
          syllables: ['x'],
          type: 'word',
          definition: 'to eat food',
          citation: { entryId: REQUESTED },
        },
      },
      ada,
    );
  });

  async function findResult(entryId: string, query: string) {
    const results = await searchKaikkiHandler(pool, query);
    const found = results.find((r) => r.entryId === entryId);
    expect(found, `no result for ${entryId}`).toBeDefined();
    return found!;
  }

  it('says an etymology is already in the dictionary, and names the word that IS it', async () => {
    expect((await findResult(CITED, `${NS}jeuncited`)).claim).toEqual({
      status: 'in_dictionary',
      wordId: `${NS}jeun_eat`,
      displayText: `${NS}jeuncited`,
    });
  });

  it('distinguishes a REQUESTED etymology from one already added', async () => {
    const claim = (await findResult(REQUESTED, `${NS}jeunrequested`)).claim;
    expect(claim).toMatchObject({ status: 'requested', wordId: `${NS}planned_word` });
    expect(claim?.contributionId).toBeTruthy();
  });

  it('reports a free etymology as null, NOT undefined - "we looked" is different from "nobody looked"', async () => {
    expect((await findResult(FREE, `${NS}jeunfree`)).claim).toBeNull();
  });

  it('offers a spelling match only where identity is silent - an exempt word here', async () => {
    const result = await findResult(SHARED_SPELLING, `${NS}jeunshared`);
    expect(result.claim).toBeNull();
    expect(result.spellingMatches).toEqual([{ wordId: `${NS}jeun_loan`, displayText: `${NS}jeunshared` }]);
  });

  it('offers NO spelling match for a taken etymology - the kọ́ false positive stays suppressed', async () => {
    // A cited word sharing a spelling with a different etymology is not evidence of anything, and
    // printing it under an authoritative verdict would bury the verdict.
    expect((await findResult(CITED, `${NS}jeuncited`)).spellingMatches).toEqual([]);
  });

  it('still returns nothing for a query that matches nothing, without running the claim lookups', async () => {
    expect(await searchKaikkiHandler(pool, 'qzxvnothingmatchesthisxyz')).toEqual([]);
  });
});

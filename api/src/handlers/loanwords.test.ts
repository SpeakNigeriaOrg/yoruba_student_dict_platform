// Loanwords (0032) end to end against real Postgres: recorded on the etymology axis by a direct
// decision, by consensus, and at creation; pre-filled from the cited Wiktionary entry; and the
// backfill that completes etymology votes stored before borrowing joined the claim.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extendLegacyEtymologyFingerprint } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { applyEtymologyDecision } from './applyEtymologyDecision.js';
import { submitContribution } from './submitContribution.js';
import { confirmConsensus } from './confirmConsensus.js';
import { listConsensus } from './listConsensus.js';
import { createWord } from './createWord.js';
import { getEtymologyReview } from './getEtymologyReview.js';
import { applyEntryUsageBackfill, planEntryUsageBackfill } from './backfillEntryUsageFields.js';
import { writeCitationInTransaction } from './upstreamCitations.js';

const NS = 'testloan_';
const ENTRY_NS = 'testloan-entry-';
const pool = getTestPool();
let ada: string;
let ben: string;
let curator: string;

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
  ada = await mk('ada@example.com', 'volunteer');
  ben = await mk('ben@example.com', 'volunteer');
  curator = await mk('curator@example.com', 'curator');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

let seq = 0;
async function word(): Promise<string> {
  seq += 1;
  const wordId = `${NS}redio${seq}`;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'rédíò',
    ['ré', 'dí', 'ò'],
    'radio',
  ]);
  await writeCitationInTransaction(pool, wordId, { exemptReason: 'recent loanword' }, curator);
  return wordId;
}

async function borrowing(wordId: string) {
  return (
    await pool.query<{ borrowed_from: string | null; borrowed_term: string | null }>(
      'select borrowed_from, borrowed_term from golden_record where word_id = $1',
      [wordId],
    )
  ).rows[0];
}

const RADIO = { componentsAction: 'confirm_atomic', borrowedAction: 'set', borrowedFrom: 'en', borrowedTerm: 'radio' } as const;

describe('loanwords', () => {
  it('a direct etymology decision records it', async () => {
    const wordId = await word();
    await applyEtymologyDecision(pool, wordId, RADIO, curator);
    expect(await borrowing(wordId)).toEqual({ borrowed_from: 'en', borrowed_term: 'radio' });
  });

  it('two agreeing volunteers reach consensus, and confirming writes it', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'etymology', wordId, proposedValue: RADIO }, ada);
    await submitContribution(pool, { axis: 'etymology', wordId, proposedValue: RADIO }, ben);
    const [g] = await listConsensus(pool, { wordId, axis: 'etymology', buckets: ['ready'] });
    expect(g.summary.bucket).toBe('ready');
    await confirmConsensus(pool, { items: [{ wordId, axis: 'etymology' }] }, curator);
    expect(await borrowing(wordId)).toEqual({ borrowed_from: 'en', borrowed_term: 'radio' });
  });

  it('a disagreement about the source language is contested and named', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'etymology', wordId, proposedValue: RADIO }, ada);
    await submitContribution(pool, { axis: 'etymology', wordId, proposedValue: { ...RADIO, borrowedFrom: 'ha', borrowedTerm: null } }, ben);
    const [g] = await listConsensus(pool, { wordId, axis: 'etymology', buckets: ['contested'] });
    expect(g.summary.differingFields).toEqual(['borrowing']);
  });

  it('is recorded at creation, and the author votes for it on the etymology axis', async () => {
    const wordId = `${NS}kasuwa_market`;
    await createWord(
      pool,
      { wordId, displayText: 'kasuwa', syllables: ['ka', 'su', 'wa'], citation: { exemptReason: 'loanword' }, borrowedFrom: 'ha', borrowedTerm: 'kasuwa' },
      curator,
    );
    expect(await borrowing(wordId)).toEqual({ borrowed_from: 'ha', borrowed_term: 'kasuwa' });
    const vote = await pool.query<{ resolved_value: Record<string, unknown> }>(
      "select resolved_value from contributions where word_id = $1 and axis = 'etymology'",
      [wordId],
    );
    expect(vote.rows[0].resolved_value).toMatchObject({ borrowedFrom: 'ha', borrowedTerm: 'kasuwa' });
  });

  it("is offered from the cited Wiktionary entry's own {{bor}}", async () => {
    const entryId = `${ENTRY_NS}tunisia`;
    await insertTestKaikkiSense(pool, { entryId, headword: 'Tunisia', canonicalValue: 'Tùnísíà', pos: 'name', glosses: ['Tunisia'] });
    await pool.query("update kaikki_senses set borrowed_from = 'en-GB', borrowed_term = 'Tunisia' where entry_id = $1", [entryId]);
    const wordId = `${NS}tunisia`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [wordId, 'Tùnísíà', ['Tù', 'ní', 'sí', 'à']]);
    await writeCitationInTransaction(pool, wordId, { entryId }, curator);
    const review = await getEtymologyReview(pool, wordId, ada);
    // en-GB is English as far as the list goes.
    expect(review.wiktionaryBorrowing).toEqual({ from: 'en', term: 'Tunisia' });
    expect(review.borrowing).toBeNull();
  });

  it('the backfill completes a pre-0032 etymology vote as "not borrowed", exactly', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'etymology', wordId, proposedValue: { componentsAction: 'confirm_atomic' } }, ada);
    const stored = await pool.query<{ contribution_id: string; value_fingerprint: string; resolved_value: Record<string, unknown> }>(
      "select contribution_id, value_fingerprint, resolved_value from contributions where word_id = $1 and axis = 'etymology'",
      [wordId],
    );
    const { contribution_id: id, value_fingerprint: current, resolved_value: outcome } = stored.rows[0];
    const legacy = current.split(String.fromCharCode(0x1f)).slice(0, 3).join(String.fromCharCode(0x1f));
    const { borrowedFrom: _f, borrowedTerm: _t, ...older } = outcome;
    await pool.query('update contributions set value_fingerprint = $1, resolved_value = $2 where contribution_id = $3', [legacy, older, id]);
    expect(extendLegacyEtymologyFingerprint(legacy)).toBe(current);

    const plan = await planEntryUsageBackfill(pool);
    const mine = { planned: plan.planned.filter((p) => p.wordId === wordId && p.axis === 'etymology') };
    expect(mine.planned).toHaveLength(1);
    expect((await applyEntryUsageBackfill(pool, mine)).written).toBe(1);
    const after = await pool.query<{ value_fingerprint: string }>('select value_fingerprint from contributions where contribution_id = $1', [id]);
    expect(after.rows[0].value_fingerprint).toBe(current);
  });
});

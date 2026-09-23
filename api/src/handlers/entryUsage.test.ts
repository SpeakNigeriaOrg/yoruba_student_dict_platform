// Part of speech, usage labels and the only-in-derived-terms flag (0029) end to end against real
// Postgres: a curator's direct decision, a consensus confirmation, the pin fallback, the affix
// rule, and the backfill that completes votes cast before those fields existed.
//
// The case running through it is lá "to be big" - filed as a particle, when it is an obsolete
// verb that survives inside ńlá.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extendLegacyEntryFingerprint, fingerprintOutcome } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { createWord } from './createWord.js';
import { parseCreationUsage } from '../entryUsage.js';
import { applyEntryDecision, type ApplyEntryDecisionInput } from './applyEntryDecision.js';
import { submitContribution } from './submitContribution.js';
import { confirmConsensus } from './confirmConsensus.js';
import { listConsensus } from './listConsensus.js';
import { loadEntryUsage } from './getEntryReview.js';
import { applyEntryUsageBackfill, planEntryUsageBackfill } from './backfillEntryUsageFields.js';
import { InvalidEntryUsageError } from '../entryUsage.js';

const NS = 'testusage_';
const ENTRY_NS = 'testusage-entry-';
const pool = getTestPool();
let ada: string;
let ben: string;
let curator: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
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
/** A word, optionally with a pinned citation whose pin names a part of speech. */
async function word(opts: { pos?: string | null; pinPos?: string } = {}): Promise<string> {
  seq += 1;
  const wordId = `${NS}la${seq}`;
  await pool.query(
    'insert into golden_record (word_id, display_text, syllables, definition, pos) values ($1, $2, $3, $4, $5)',
    [wordId, 'lá', ['lá'], 'to be big', opts.pos ?? null],
  );
  if (opts.pinPos) {
    await pool.query(
      `insert into upstream_citations (word_id, entry_id, pin, pinned_by) values ($1, $2, $3::jsonb, $4)`,
      [wordId, `${NS}entry${seq}`, JSON.stringify({ pos: opts.pinPos }), curator],
    );
  }
  return wordId;
}

async function record(wordId: string) {
  return (
    await pool.query<{ pos: string | null; usage_labels: string[]; only_in_derived_terms: boolean }>(
      'select pos, usage_labels, only_in_derived_terms from golden_record where word_id = $1',
      [wordId],
    )
  ).rows[0];
}

const KEEP = { action: 'keep_ours', definitionAction: 'confirm' } as const;
const LA_FIX: ApplyEntryDecisionInput = {
  ...KEEP,
  posAction: 'set',
  pos: 'verb',
  usageLabelsAction: 'set',
  usageLabels: ['obsolete'],
  onlyInDerivedTermsAction: 'set',
  onlyInDerivedTerms: true,
};

describe('at creation', () => {
  it('creates lá already obsolete and surviving only inside other words, and the author votes for that', async () => {
    const wordId = `${NS}la_be_big`;
    await createWord(
      pool,
      {
        wordId,
        displayText: 'lá',
        syllables: ['lá'],
        definition: 'to be big',
        citation: { exemptReason: 'no Wiktionary sense for this meaning' },
        pos: 'verb',
        usageLabels: ['obsolete'],
        onlyInDerivedTerms: true,
      },
      curator,
    );
    expect(await record(wordId)).toEqual({ pos: 'verb', usage_labels: ['obsolete'], only_in_derived_terms: true });

    const vote = await pool.query<{ resolved_value: Record<string, unknown> }>(
      "select resolved_value from contributions where word_id = $1 and axis = 'entry'",
      [wordId],
    );
    expect(vote.rows[0].resolved_value).toMatchObject({ pos: 'verb', usageLabels: ['obsolete'], onlyInDerivedTerms: true });
  });

  it('refuses the flag on a word whose CITED etymology is a suffix, and creates nothing', async () => {
    const entryId = `${ENTRY_NS}suffix`;
    await insertTestKaikkiSense(pool, {
      entryId,
      headword: 'ni',
      canonicalValue: 'ni',
      pos: 'suffix',
      etymologyNumber: null,
      etymologyText: null,
      glosses: ['a test suffix'],
    });
    const wordId = `${NS}ni_suffix`;
    await expect(
      createWord(
        pool,
        { wordId, displayText: 'ni', syllables: ['ni'], citation: { entryId }, onlyInDerivedTerms: true },
        curator,
      ),
    ).rejects.toBeInstanceOf(InvalidEntryUsageError);
    expect((await pool.query('select 1 from golden_record where word_id = $1', [wordId])).rowCount).toBe(0);
  });

  it('parses only the closed list off the wire', () => {
    expect(parseCreationUsage({ usageLabels: ['rare', 'obsolete'] })).toEqual({ usageLabels: ['obsolete', 'rare'] });
    expect(() => parseCreationUsage({ usageLabels: ['in compounds'] })).toThrow(InvalidEntryUsageError);
    expect(() => parseCreationUsage({ onlyInDerivedTerms: 'yes' })).toThrow(InvalidEntryUsageError);
    expect(parseCreationUsage({})).toEqual({});
  });
});

describe('a direct decision', () => {
  it('records the lá correction: verb, obsolete, only inside other words', async () => {
    const wordId = await word({ pos: 'particle' });
    await applyEntryDecision(pool, wordId, LA_FIX, curator);
    expect(await record(wordId)).toEqual({ pos: 'verb', usage_labels: ['obsolete'], only_in_derived_terms: true });
  });

  it('stores null, not a copy, when the chosen pos is what the pin already says', async () => {
    const wordId = await word({ pos: 'particle', pinPos: 'verb' });
    await applyEntryDecision(pool, wordId, { ...KEEP, posAction: 'set', pos: 'verb' }, curator);
    expect((await record(wordId)).pos).toBeNull();
    expect((await loadEntryUsage(pool, wordId)).pos).toBe('verb');
  });

  it('stores an override when we disagree with the pin', async () => {
    const wordId = await word({ pinPos: 'particle' });
    await applyEntryDecision(pool, wordId, { ...KEEP, posAction: 'set', pos: 'verb' }, curator);
    expect((await record(wordId)).pos).toBe('verb');
  });

  it('a plain confirm changes nothing', async () => {
    const wordId = await word({ pos: 'particle' });
    await applyEntryDecision(pool, wordId, KEEP, curator);
    expect(await record(wordId)).toEqual({ pos: 'particle', usage_labels: [], only_in_derived_terms: false });
  });

  it('refuses an unknown part of speech or label', async () => {
    const wordId = await word();
    await expect(applyEntryDecision(pool, wordId, { ...KEEP, posAction: 'set', pos: 'root' }, curator)).rejects.toBeInstanceOf(
      InvalidEntryUsageError,
    );
    await expect(
      applyEntryDecision(pool, wordId, { ...KEEP, usageLabelsAction: 'set', usageLabels: ['in compounds'] }, curator),
    ).rejects.toBeInstanceOf(InvalidEntryUsageError);
  });

  it('still confirms a legacy pos typed before the closed list existed', async () => {
    const wordId = await word({ pos: 'interjection' });
    await applyEntryDecision(pool, wordId, KEEP, curator);
    expect((await record(wordId)).pos).toBe('interjection');
  });

  it('clears the flag when a decision makes the word an affix', async () => {
    const wordId = await word({ pos: 'verb' });
    await applyEntryDecision(pool, wordId, LA_FIX, curator);
    await applyEntryDecision(pool, wordId, { ...KEEP, posAction: 'set', pos: 'suffix' }, curator);
    expect(await record(wordId)).toMatchObject({ pos: 'suffix', only_in_derived_terms: false });
  });

  it("the stored decision fingerprint is what the row now holds, so later votes don't read as dissent", async () => {
    const wordId = await word({ pos: 'particle' });
    await applyEntryDecision(pool, wordId, LA_FIX, curator);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const groups = await listConsensus(pool, { wordId, buckets: ['golden', 'dissent_on_golden'] });
    expect(groups.find((g) => g.axis === 'entry')?.summary.bucket).toBe('golden');
  });
});

describe('consensus', () => {
  it('two reviewers agreeing on the correction reach ready, and confirming writes it', async () => {
    const wordId = await word({ pos: 'particle' });
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: LA_FIX }, ada);
    // Same claim, labels ticked in a different order.
    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { ...LA_FIX, usageLabels: ['obsolete', 'obsolete'] } },
      ben,
    );

    const [g] = await listConsensus(pool, { wordId, buckets: ['ready'] });
    expect(g.summary.bucket).toBe('ready');
    expect(g.currentPos).toBe('particle');

    await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);
    expect(await record(wordId)).toEqual({ pos: 'verb', usage_labels: ['obsolete'], only_in_derived_terms: true });
  });

  it('a disagreement about pos is contested and names the field', async () => {
    const wordId = await word({ pos: 'particle' });
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: { ...KEEP, posAction: 'set', pos: 'verb' } }, ben);
    const [g] = await listConsensus(pool, { wordId, buckets: ['contested'] });
    expect(g.summary.differingFields).toEqual(['partOfSpeech']);
    expect(g.summary.wordingOnly).toBe(false);
  });

  it('"suffix, ticked" and "suffix, unticked" are one claim', async () => {
    const wordId = await word({ pos: 'particle' });
    const suffix = { ...KEEP, posAction: 'set', pos: 'suffix' } as const;
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: suffix }, ada);
    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { ...suffix, onlyInDerivedTermsAction: 'set', onlyInDerivedTerms: true } },
      ben,
    );
    const [g] = await listConsensus(pool, { wordId, buckets: ['ready', 'contested'] });
    expect(g.summary.bucket).toBe('ready');
  });
});

describe('the derived terms a reviewer is shown', () => {
  it('are the words that name this one as a component', async () => {
    const la = await word({ pos: 'verb' });
    const nla = `${NS}nla`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [nla, 'ńlá', ['ń', 'lá']]);
    await pool.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 1, $2)',
      [nla, la],
    );
    expect((await loadEntryUsage(pool, la)).derivedTerms).toEqual([{ wordId: nla, displayText: 'ńlá' }]);
  });
});

describe('backfillEntryUsageFields', () => {
  it('completes a pre-0029 vote so it agrees with a new confirm, and is idempotent', async () => {
    const wordId = await word({ pos: 'noun' });
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);

    // Rewind Ada's vote to how it was stored before 0029: no usage keys, five-field fingerprint.
    const stored = await pool.query<{ contribution_id: string; value_fingerprint: string; resolved_value: Record<string, unknown> }>(
      "select contribution_id, value_fingerprint, resolved_value from contributions where word_id = $1 and axis = 'entry'",
      [wordId],
    );
    const { contribution_id: id, value_fingerprint: current, resolved_value: outcome } = stored.rows[0];
    const legacy = current.split(String.fromCharCode(0x1f)).slice(0, 5).join(String.fromCharCode(0x1f));
    const { pos: _p, usageLabels: _u, onlyInDerivedTerms: _o, ...legacyOutcome } = outcome;
    await pool.query('update contributions set value_fingerprint = $1, resolved_value = $2 where contribution_id = $3', [
      legacy,
      legacyOutcome,
      id,
    ]);
    expect(extendLegacyEntryFingerprint(legacy, 'noun')).toBe(current);

    const plan = await planEntryUsageBackfill(pool);
    const mine = { planned: plan.planned.filter((p) => p.wordId === wordId) };
    expect(mine.planned).toHaveLength(1);
    const result = await applyEntryUsageBackfill(pool, mine);
    expect(result.written).toBe(1);

    const after = await pool.query<{ value_fingerprint: string; resolved_value: Record<string, unknown> }>(
      'select value_fingerprint, resolved_value from contributions where contribution_id = $1',
      [id],
    );
    expect(after.rows[0].value_fingerprint).toBe(current);
    expect(after.rows[0].resolved_value).toMatchObject({ pos: 'noun', usageLabels: [], onlyInDerivedTerms: false });
    expect(fingerprintOutcome(after.rows[0].resolved_value as never)).toBe(current);

    // A new vote confirming the same word now agrees with the backfilled one.
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    const [g] = await listConsensus(pool, { wordId, buckets: ['ready', 'contested'] });
    expect(g.summary.bucket).toBe('ready');

    const again = await planEntryUsageBackfill(pool);
    expect(again.planned.filter((p) => p.wordId === wordId)).toEqual([]);
  });
});

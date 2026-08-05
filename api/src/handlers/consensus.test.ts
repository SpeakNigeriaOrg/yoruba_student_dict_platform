// End-to-end consensus behaviour against real Postgres: submission freezing,
// tallying, bulk confirmation, exclusion, superseding, and post-golden dissent.
//
// shared/src/consensus.test.ts already covers the pure logic exhaustively. What
// is verified here is the parts that only exist once a database is involved -
// that outcomes are actually frozen at submit time, that the one-active-vote
// index does what it claims, that confirmation re-verifies rather than trusting
// the caller, and that nothing ever deletes a belief.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGREEMENT_THRESHOLD, fingerprintOutcome, type EntryOutcome } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { submitContribution } from './submitContribution.js';
import { listConsensus } from './listConsensus.js';
import { confirmConsensus } from './confirmConsensus.js';
import { excludeContribution, ContributionNotActiveError } from './excludeContribution.js';
import { applyEntryDecision } from './applyEntryDecision.js';

const NS = 'testcons_';
const pool = getTestPool();
let ada: string;
let ben: string;
let cy: string;
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
  cy = await mk('cy@example.com', 'volunteer');
  curator = await mk('curator@example.com', 'curator');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

let wordSeq = 0;
async function word(definition: string | null = 'stomach'): Promise<string> {
  wordSeq += 1;
  const wordId = `${NS}w${wordSeq}`;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'ikun',
    ['i', 'kun'],
    definition,
  ]);
  return wordId;
}

/** The group for one word from the curator queue, whatever bucket it lands in. */
async function group(wordId: string) {
  const groups = await listConsensus(pool, { buckets: ['contested', 'dissent_on_golden', 'ready', 'single', 'golden', 'none'] });
  return groups.find((g) => g.wordId === wordId && g.axis === 'entry');
}

const KEEP = { action: 'keep_ours', definitionAction: 'confirm' } as const;
const BELLY = { action: 'keep_ours', definitionAction: 'custom', definitionText: 'belly' } as const;

describe('submitContribution freezes the outcome', () => {
  it('stores the resolved outcome and fingerprint alongside the raw proposal', async () => {
    const wordId = await word();
    const { contributionId } = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);

    const row = await pool.query<{
      proposed_value: unknown;
      resolved_value: EntryOutcome;
      value_fingerprint: string;
      status: string;
    }>('select proposed_value, resolved_value, value_fingerprint, status from contributions where contribution_id = $1', [
      contributionId,
    ]);
    expect(row.rows[0].proposed_value).toEqual(KEEP);
    expect(row.rows[0].resolved_value).toEqual({
      kind: 'entry',
      displayText: 'ikun',
      syllables: ['i', 'kun'],
      definitionText: 'stomach',
    });
    expect(row.rows[0].value_fingerprint).toBe(fingerprintOutcome(row.rows[0].resolved_value));
    expect(row.rows[0].status).toBe('active');
  });

  it('does NOT reinterpret a frozen outcome when the word later changes', async () => {
    // The whole point. `keep_ours` meant "stomach" when Ada said it; the record
    // changing afterwards must not put a different claim in her mouth.
    const wordId = await word('stomach');
    const { contributionId } = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);

    await pool.query("update golden_record set definition = 'something else entirely' where word_id = $1", [wordId]);

    const row = await pool.query<{ resolved_value: EntryOutcome }>(
      'select resolved_value from contributions where contribution_id = $1',
      [contributionId],
    );
    expect(row.rows[0].resolved_value.definitionText).toBe('stomach');
  });

  it('handles a word with no definition (the NUL-byte fingerprint case)', async () => {
    const wordId = await word(null);
    const { contributionId } = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const row = await pool.query<{ value_fingerprint: string }>(
      'select value_fingerprint from contributions where contribution_id = $1',
      [contributionId],
    );
    expect(row.rows[0].value_fingerprint).toBeTruthy();
  });
});

describe('one active vote per person, history retained', () => {
  it('supersedes the submitter\'s own prior vote rather than overwriting it', async () => {
    const wordId = await word();
    const first = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const second = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: BELLY }, ada);

    expect(second.supersededPrior).toBe(true);

    const rows = await pool.query<{ contribution_id: string; status: string; resolved_value: EntryOutcome }>(
      'select contribution_id, status, resolved_value from contributions where word_id = $1 order by submitted_at',
      [wordId],
    );
    expect(rows.rows).toHaveLength(2);
    // The old belief is still there, verbatim, just no longer counted.
    const old = rows.rows.find((r) => r.contribution_id === first.contributionId)!;
    expect(old.status).toBe('superseded');
    expect(old.resolved_value.definitionText).toBe('stomach');
    const live = rows.rows.find((r) => r.contribution_id === second.contributionId)!;
    expect(live.status).toBe('active');
    expect(live.resolved_value.definitionText).toBe('belly');

    // ...and only the live one is tallied.
    const g = await group(wordId);
    expect(g?.summary.totalVotes).toBe(1);
    expect(g?.summary.winner?.outcome).toMatchObject({ definitionText: 'belly' });
  });

  it('does not report supersededPrior on a first submission', async () => {
    const wordId = await word();
    const result = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    expect(result.supersededPrior).toBe(false);
  });
});

describe('the three-volunteer scenario', () => {
  it('two agreeing plus one dissenting reports contested, with attribution', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: BELLY }, cy);

    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('contested');
    expect(g?.summary.totalVotes).toBe(3);
    expect(g?.summary.tally).toHaveLength(2);
    // The majority is still offered so a curator can resolve in one click.
    expect(g?.summary.winner?.count).toBe(2);
    expect(g?.summary.winner?.voterLabels.sort()).toEqual([`${NS}ada@example.com`, `${NS}ben@example.com`]);
    const minority = g!.summary.tally.find((t) => t.count === 1)!;
    expect(minority.voterLabels).toEqual([`${NS}cy@example.com`]);
  });

  it('two agreeing alone is ready for bulk confirmation', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);

    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('ready');
    expect(g?.summary.agreementCount).toBe(AGREEMENT_THRESHOLD);
  });

  it('a single vote is provisional but below the bar', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('single');
  });

  it('orders the queue with conflicts ahead of confirmable ones', async () => {
    const contested = await word();
    await submitContribution(pool, { axis: 'entry', wordId: contested, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId: contested, proposedValue: BELLY }, ben);
    const ready = await word();
    await submitContribution(pool, { axis: 'entry', wordId: ready, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId: ready, proposedValue: KEEP }, ben);

    const groups = await listConsensus(pool);
    const mine = groups.filter((g) => g.wordId === contested || g.wordId === ready);
    expect(mine[0].wordId).toBe(contested);
  });
});

describe('exclusion removes a vote without deleting the belief', () => {
  it('drops the excluded vote from the tally but keeps the row intact', async () => {
    const wordId = await word();
    const spam = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: BELLY }, cy);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);

    expect((await group(wordId))?.summary.bucket).toBe('contested');

    await excludeContribution(pool, spam.contributionId, curator, 'test data');

    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('ready');
    expect(g?.summary.totalVotes).toBe(2);

    const row = await pool.query<{ status: string; resolved_value: EntryOutcome; excluded_reason: string; proposed_value: unknown }>(
      'select status, resolved_value, excluded_reason, proposed_value from contributions where contribution_id = $1',
      [spam.contributionId],
    );
    expect(row.rows[0].status).toBe('excluded');
    expect(row.rows[0].excluded_reason).toBe('test data');
    // The belief survives in full.
    expect(row.rows[0].proposed_value).toEqual(BELLY);
    expect(row.rows[0].resolved_value.definitionText).toBe('belly');
  });

  it('refuses to exclude a row that is not active', async () => {
    const wordId = await word();
    const c = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await excludeContribution(pool, c.contributionId, curator);
    await expect(excludeContribution(pool, c.contributionId, curator)).rejects.toBeInstanceOf(ContributionNotActiveError);
  });
});

describe('confirmConsensus', () => {
  it('writes the agreed outcome to golden_record and records the decision', async () => {
    const wordId = await word('stomach');
    const changed = { action: 'keep_ours', definitionAction: 'custom', definitionText: 'the belly' } as const;
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: changed }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: changed }, ben);

    const result = await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]).toMatchObject({ wordId, axis: 'entry', agreementCount: 2 });
    expect(result.skipped).toEqual([]);

    const gr = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(gr.rows[0].definition).toBe('the belly');

    const decision = await pool.query<{ decided_by: string; value_fingerprint: string; note: string }>(
      "select decided_by, value_fingerprint, note from word_decisions where word_id = $1 and axis = 'entry'",
      [wordId],
    );
    expect(decision.rows[0].decided_by).toBe(curator);
    expect(decision.rows[0].value_fingerprint).toBeTruthy();
    expect(decision.rows[0].note).toMatch(/2 agreeing/);
  });

  it('confirms many words in one call', async () => {
    const ids = [await word(), await word(), await word()];
    for (const wordId of ids) {
      await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
      await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    }

    const result = await confirmConsensus(pool, { items: ids.map((wordId) => ({ wordId, axis: 'entry' as const })) }, curator);

    expect(result.confirmed.map((c) => c.wordId).sort()).toEqual([...ids].sort());
    expect(result.skipped).toEqual([]);
  });

  it('refuses a stale expectation rather than writing what nobody voted for', async () => {
    // The bulk-confirm hazard: the curator loaded the queue, then the winning
    // claim changed underneath them.
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);

    const result = await confirmConsensus(
      pool,
      { items: [{ wordId, axis: 'entry', expectedFingerprint: 'a-fingerprint-nobody-submitted' }] },
      curator,
    );

    expect(result.confirmed).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ wordId, reason: 'changed_since_you_looked' });
    const decision = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    expect(decision.rowCount).toBe(0);
  });

  it('accepts a matching expectation', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const g = await group(wordId);
    const expectedFingerprint = g!.summary.winner!.fingerprint;

    const result = await confirmConsensus(pool, { items: [{ wordId, axis: 'entry', expectedFingerprint }] }, curator);
    expect(result.confirmed).toHaveLength(1);
  });

  it('skips a tie - there is no winner to confirm', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: BELLY }, ben);

    const result = await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);
    expect(result.confirmed).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'no_clear_winner' });
  });

  it('skips a word with no contributions', async () => {
    const wordId = await word();
    const result = await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);
    expect(result.skipped[0]).toMatchObject({ reason: 'no_contributions' });
  });

  it('reports partial success rather than failing the whole batch', async () => {
    const good = await word();
    await submitContribution(pool, { axis: 'entry', wordId: good, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId: good, proposedValue: KEEP }, ben);
    const bad = await word();

    const result = await confirmConsensus(
      pool,
      { items: [{ wordId: good, axis: 'entry' }, { wordId: bad, axis: 'entry' }] },
      curator,
    );

    expect(result.confirmed.map((c) => c.wordId)).toEqual([good]);
    expect(result.skipped.map((s) => s.wordId)).toEqual([bad]);
  });
});

describe('post-golden dissent', () => {
  it('re-flags a word when a later contribution disagrees, without disturbing the decision', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);

    expect((await group(wordId))?.summary.bucket).toBe('golden');

    const dissent = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: BELLY }, cy);
    // Spaced deliberately - see the note on millisecond granularity below.
    await pool.query(
      "update contributions set submitted_at = submitted_at + interval '1 second' where contribution_id = $1",
      [dissent.contributionId],
    );

    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('dissent_on_golden');
    expect(g?.summary.dissentsFromGolden).toHaveLength(1);
    expect(g?.summary.dissentsFromGolden[0].voterLabels).toEqual([`${NS}cy@example.com`]);

    // The golden decision stands until a curator acts on the dissent.
    const decision = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    expect(decision.rowCount).toBe(1);
  });

  it('an agreeing later contribution changes nothing', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);

    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, cy);

    expect((await group(wordId))?.summary.bucket).toBe('golden');
  });

  it('skips re-confirming an unchanged golden decision', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);

    const again = await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);
    expect(again.skipped[0]).toMatchObject({ reason: 'already_golden_and_unchanged' });
  });

  it("a curator's own direct decision is fingerprinted, so dissent works against it too", async () => {
    const wordId = await word();
    await applyEntryDecision(pool, wordId, { action: 'keep_ours', definitionAction: 'confirm' }, curator);

    const stored = await pool.query<{ value_fingerprint: string }>(
      "select value_fingerprint from word_decisions where word_id = $1 and axis = 'entry'",
      [wordId],
    );
    expect(stored.rows[0].value_fingerprint).toBeTruthy();

    const dissent = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: BELLY }, cy);
    // Timestamps are compared at millisecond granularity (see
    // ConsensusSummary.dissentsFromGolden), and these two writes can land in
    // the same millisecond - which made this test flaky rather than wrong.
    // Spacing it explicitly is what the assertion actually cares about:
    // a contribution that came LATER and disagrees.
    await pool.query(
      "update contributions set submitted_at = submitted_at + interval '1 second' where contribution_id = $1",
      [dissent.contributionId],
    );

    expect((await group(wordId))?.summary.bucket).toBe('dissent_on_golden');
  });
});

describe('listConsensus filtering', () => {
  it('excludes settled and untouched words by default', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ben);
    await confirmConsensus(pool, { items: [{ wordId, axis: 'entry' }] }, curator);

    const actionable = await listConsensus(pool);
    expect(actionable.find((g) => g.wordId === wordId)).toBeUndefined();

    const all = await listConsensus(pool, { buckets: ['golden'] });
    expect(all.find((g) => g.wordId === wordId)).toBeDefined();
  });

  it('can restrict to one axis', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const etymOnly = await listConsensus(pool, { axis: 'etymology' });
    expect(etymOnly.find((g) => g.wordId === wordId)).toBeUndefined();
  });
});

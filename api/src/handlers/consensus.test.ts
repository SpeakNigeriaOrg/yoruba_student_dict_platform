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
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import { submitContribution } from './submitContribution.js';
import { listConsensus } from './listConsensus.js';
import { confirmConsensus } from './confirmConsensus.js';
import { excludeContribution, ContributionNotActiveError } from './excludeContribution.js';
import { applyEntryDecision } from './applyEntryDecision.js';

const NS = 'testcons_';
const ENTRY_NS = 'testcons-entry-';
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

  // The two-etymologies-one-spelling fixture (the `kọ́` shape) is minted per case by citedWord()
  // below, not once here - see the note there.
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
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
      // These test words are created without a citation, so the contributor is
      // asserting "no etymology cited" - which is itself the state they saw.
      citedEntryId: null,
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

describe('the cited etymology is part of what a contribution asserts', () => {
  /** A word already citing one etymology, plus a second etymology of the SAME spelling to move it to -
   * the `kọ́` shape, so a contributor can either agree with the citation or name a different one.
   *
   * Both etymologies are minted PER CALL. Since 0017 an etymology is the identity of at most one word,
   * so cases cannot share a fixture etymology the way they used to: two tests each creating a word
   * citing one `HANG` is now the very contradiction the constraint exists to prevent. Per-call ids
   * also make each case independent, which it should always have been. */
  let pairCounter = 0;
  async function citedWord(): Promise<{ wordId: string; hang: string; build: string }> {
    pairCounter += 1;
    const hang = `${ENTRY_NS}hang${pairCounter}`;
    const build = `${ENTRY_NS}build${pairCounter}`;
    for (const [entryId, etym, gloss] of [
      [hang, '4', 'to hang, suspend'],
      [build, '2', 'to build, construct'],
    ] as const) {
      await insertTestKaikkiSense(pool, { entryId, headword: 'ikun', canonicalValue: 'ikun', etymologyNumber: etym, glosses: [gloss] });
    }
    const wordId = await word('to hang, suspend');
    await pool.query(
      `insert into upstream_citations (word_id, entry_id, pin, pinned_by) values ($1, $2, '{}'::jsonb, $3)`,
      [wordId, hang, curator],
    );
    return { wordId, hang, build };
  }

  it('freezes the etymology the word cited, even when the contributor never mentions it', async () => {
    const { wordId, hang, build } = await citedWord();
    const { contributionId } = await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const row = await pool.query<{ resolved_value: EntryOutcome }>(
      'select resolved_value from contributions where contribution_id = $1',
      [contributionId],
    );
    expect(row.rows[0].resolved_value.citedEntryId).toBe(hang);
  });

  it('two people citing DIFFERENT etymologies of one spelling are contested, not agreed', async () => {
    // Both say "keep the spelling, keep the definition". Under the old
    // fingerprint they agreed and would have crossed the threshold together.
    const { wordId, hang, build } = await citedWord();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { ...KEEP, senseEntryId: build } },
      ben,
    );

    const g = await group(wordId);
    expect(g?.summary.totalVotes).toBe(2);
    expect(g?.summary.bucket).toBe('contested');
  });

  it('two people citing the SAME etymology still reach agreement', async () => {
    const { wordId, hang, build } = await citedWord();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: { ...KEEP, senseEntryId: hang } }, ben);

    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('ready');
    expect(g?.summary.agreementCount).toBe(AGREEMENT_THRESHOLD);
  });

  it('confirming a consensus that moved the etymology re-cites the word', async () => {
    const { wordId, hang, build } = await citedWord();
    const proposal = { ...KEEP, senseEntryId: build };
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: proposal }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: proposal }, ben);

    const g = await group(wordId);
    await confirmConsensus(
      pool,
      { items: [{ wordId, axis: 'entry', expectedFingerprint: g!.summary.winner!.fingerprint }] },
      curator,
    );

    const cited = await pool.query<{ entry_id: string }>('select entry_id from upstream_citations where word_id = $1', [
      wordId,
    ]);
    expect(cited.rows[0].entry_id).toBe(build);
  });

  it('a routine confirmation does not restamp the pin - pinned_at means "last verified upstream"', async () => {
    const { wordId, hang, build } = await citedWord();
    const before = await pool.query<{ pinned_at: Date }>('select pinned_at from upstream_citations where word_id = $1', [
      wordId,
    ]);
    await applyEntryDecision(pool, wordId, { ...KEEP, senseEntryId: hang }, curator);
    const after = await pool.query<{ pinned_at: Date }>('select pinned_at from upstream_citations where word_id = $1', [
      wordId,
    ]);
    expect(after.rows[0].pinned_at).toEqual(before.rows[0].pinned_at);
  });

  it("a curator's decision naming a different etymology re-cites it and pins upstream content", async () => {
    const { wordId, hang, build } = await citedWord();
    await applyEntryDecision(pool, wordId, { ...KEEP, senseEntryId: build }, curator);
    const { rows } = await pool.query<{ entry_id: string; pin: Record<string, unknown> }>(
      'select entry_id, pin from upstream_citations where word_id = $1',
      [wordId],
    );
    expect(rows[0].entry_id).toBe(build);
    // Re-pinned from the corpus, not left holding the old etymology's content.
    expect(rows[0].pin).toMatchObject({ etymologyNumber: '2', glosses: ['to build, construct'] });
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

  it('can restrict to one word, for its dossier', async () => {
    // A curator reads the tally next to everything else known about the word and decides
    // there, which is where setting the record now lives.
    const mine = await word();
    const other = await word();
    await submitContribution(pool, { axis: 'entry', wordId: mine, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId: other, proposedValue: KEEP }, ben);

    const groups = await listConsensus(pool, { wordId: mine });
    expect(groups.map((g) => g.wordId)).toEqual([mine]);
  });

  it('combines the word filter with the axis and bucket filters', async () => {
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    expect(await listConsensus(pool, { wordId, axis: 'etymology' })).toEqual([]);
    expect(await listConsensus(pool, { wordId, buckets: ['contested'] })).toEqual([]);
    expect(await listConsensus(pool, { wordId, buckets: ['single'] })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Making a claim readable
// ---------------------------------------------------------------------------
//
// A tally is only useful if a curator can tell what each claim SAYS. Two of the fields a
// claim asserts are stored as keys - a component is a word_id, a cited etymology is an
// opaque upstream token - and neither could be read as-is:
//
//   - word_ids are orthography-insensitive by construction, so `oju_eye` cannot say whether
//     the claim is about `ojú` or `òjò`. Tone is the commonest thing being adjudicated.
//   - an entry id says nothing at all, and it is part of the fingerprint: two claims that
//     differ ONLY on which etymology they cite are a real disagreement about which word this
//     is, and they render identically without it.
//
// So the handler resolves both, batched across the whole result.
describe('listConsensus resolves the ids inside a claim', () => {
  it('labels the etymology an entry claim cites, and the one on record', async () => {
    const hangId = `${ENTRY_NS}lbl_hang`;
    const buildId = `${ENTRY_NS}lbl_build`;
    await insertTestKaikkiSense(pool, {
      entryId: hangId,
      headword: 'ikun',
      canonicalValue: 'ikùn',
      etymologyNumber: '4',
      glosses: ['to hang, suspend'],
    });
    await insertTestKaikkiSense(pool, {
      entryId: buildId,
      headword: 'ikun',
      canonicalValue: 'ikún',
      etymologyNumber: '2',
      glosses: ['to build, construct'],
    });
    const wordId = await word('to hang, suspend');
    await pool.query(`insert into upstream_citations (word_id, entry_id, pin, pinned_by) values ($1, $2, '{}'::jsonb, $3)`, [
      wordId,
      hangId,
      curator,
    ]);

    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: { ...KEEP, senseEntryId: buildId } }, ben);

    const g = await group(wordId);
    expect(g?.summary.bucket).toBe('contested');
    // Both claims' etymologies, so the row that differs only in its citation can say so.
    expect(g?.labels.etymologies[hangId]).toEqual({
      entryId: hangId,
      form: 'ikùn',
      pos: 'verb',
      etymologyNumber: '4',
      glosses: ['to hang, suspend'],
    });
    expect(g?.labels.etymologies[buildId]?.glosses).toEqual(['to build, construct']);
    // And what the record currently says, so the claims have a baseline to be compared to.
    expect(g?.currentCitedEntryId).toBe(hangId);
    expect(g?.currentSyllables).toEqual(['i', 'kun']);
  });

  it('spells the components an etymology claim names', async () => {
    const parent = await word('house-front');
    const eye = await word('eye');
    const house = await word('house');
    await pool.query('update golden_record set display_text = $2 where word_id = $1', [eye, 'ojú']);
    await pool.query('update golden_record set display_text = $2 where word_id = $1', [house, 'ilé']);

    await submitContribution(
      pool,
      { axis: 'etymology', wordId: parent, proposedValue: { componentsAction: 'custom', components: [eye, house] } },
      ada,
    );

    const groups = await listConsensus(pool, { wordId: parent, axis: 'etymology', buckets: ['single'] });
    expect(groups).toHaveLength(1);
    expect(groups[0].labels.components).toEqual({ [eye]: 'ojú', [house]: 'ilé' });
  });

  it('leaves a component whose word has been deleted unlabelled rather than labelling it with its own id', async () => {
    // The client falls back to the raw id. Dressing a dangling reference up as one that
    // resolved would say the word still exists, which is the one thing worth not saying.
    const parent = await word('gone');
    const doomed = await word('doomed');
    await submitContribution(
      pool,
      { axis: 'etymology', wordId: parent, proposedValue: { componentsAction: 'custom', components: [doomed] } },
      ada,
    );
    await pool.query('delete from golden_record_components where word_id = $1', [parent]);
    await pool.query('delete from golden_record where word_id = $1', [doomed]);

    const groups = await listConsensus(pool, { wordId: parent, axis: 'etymology', buckets: ['single'] });
    expect(groups[0].labels.components).toEqual({});
  });

  it('does not query at all when no claim refers to anything', async () => {
    // An uncited word with a plain entry claim names no component and cites no etymology.
    const wordId = await word();
    await submitContribution(pool, { axis: 'entry', wordId, proposedValue: KEEP }, ada);
    const g = await group(wordId);
    expect(g?.labels).toEqual({ components: {}, etymologies: {} });
    expect(g?.currentCitedEntryId).toBeNull();
  });
});

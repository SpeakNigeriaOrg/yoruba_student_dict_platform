// The curator's authoring counts as one ordinary vote.
//
// The behaviour under test is not really the insert - it is what the insert does to consensus.
// Before this, an authored word had no representation in the tally at all: no word_decisions row
// (so no GoldenReference, so dissent could never be computed) and no contribution (so no vote).
// Two volunteers could reach 'ready' and be bulk-confirmed over the author with nothing on screen
// saying a conflict existed. The bucket assertions below are the real subject.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGREEMENT_THRESHOLD } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { createWord } from './createWord.js';
import { createPhrase } from './createPhrase.js';
import { submitContribution } from './submitContribution.js';
import { listConsensus } from './listConsensus.js';

const NS = 'testav_';
const EXEMPT = { exemptReason: 'test word, no upstream entry' } as const;
const pool = getTestPool();
let curator: string;
let ada: string;
let ben: string;

/** The bucket this word/axis currently sits in, or null when it is in none of them. */
async function bucketOf(wordId: string, axis: 'entry' | 'etymology') {
  const groups = await listConsensus(pool, {
    buckets: ['none', 'single', 'ready', 'contested', 'dissent_on_golden', 'golden'],
    axis,
  });
  return groups.find((g) => g.wordId === wordId)?.summary.bucket ?? null;
}

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const mk = async (email: string, role: 'curator' | 'volunteer') =>
    (
      await pool.query<{ user_id: string }>(
        'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
        [`${NS}${email}`, email, role],
      )
    ).rows[0].user_id;
  curator = await mk('curator@example.com', 'curator');
  ada = await mk('ada@example.com', 'volunteer');
  ben = await mk('ben@example.com', 'volunteer');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('createWord records the author as one voter', () => {
  it('casts an entry-axis vote whose frozen outcome is what was authored', async () => {
    const wordId = `${NS}epo_oil`;
    await createWord(
      pool,
      { wordId, displayText: 'epo', syllables: ['e', 'po'], definition: 'oil', citation: EXEMPT },
      curator,
    );

    const rows = await pool.query<{ axis: string; submitted_by: string; resolved_value: Record<string, unknown> }>(
      "select axis, submitted_by, resolved_value from contributions where word_id = $1 and status = 'active'",
      [wordId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].axis).toBe('entry');
    expect(rows.rows[0].submitted_by).toBe(curator);
    // Resolved against the record inside the create transaction, so it is the authored content -
    // not a second construction of it that could drift.
    expect(rows.rows[0].resolved_value).toMatchObject({
      kind: 'entry',
      displayText: 'epo',
      syllables: ['e', 'po'],
      definitionText: 'oil',
    });
  });

  it('does NOT write a word_decisions row, so the axis is still open for review', async () => {
    const wordId = `${NS}undecided`;
    await createWord(pool, { wordId, displayText: 'x', syllables: ['x'], citation: EXEMPT }, curator);

    const decisions = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    // A vote says "this is my answer". A decision says "this question is settled". Authoring is
    // only ever the first of those.
    expect(decisions.rowCount).toBe(0);
  });

  it('casts no etymology vote when no decomposition was recorded', async () => {
    const wordId = `${NS}atomic_word`;
    await createWord(pool, { wordId, displayText: 'y', syllables: ['y'], citation: EXEMPT }, curator);

    // Silence is not a vote for 'atomic'. The section is optional and collapsed; never opening it
    // is not a claim, and confirm_atomic here would put one in the author's mouth.
    const rows = await pool.query("select 1 from contributions where word_id = $1 and axis = 'etymology'", [wordId]);
    expect(rows.rowCount).toBe(0);
  });

  it('casts an etymology vote when a decomposition WAS recorded', async () => {
    await createWord(pool, { wordId: `${NS}part_a`, displayText: 'a', syllables: ['a'], citation: EXEMPT }, curator);
    const wordId = `${NS}compound`;
    await createWord(
      pool,
      { wordId, displayText: 'ab', syllables: ['ab'], citation: EXEMPT, components: [`${NS}part_a`] },
      curator,
    );

    const rows = await pool.query<{ resolved_value: Record<string, unknown> }>(
      "select resolved_value from contributions where word_id = $1 and axis = 'etymology' and status = 'active'",
      [wordId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].resolved_value).toMatchObject({ kind: 'etymology', components: [`${NS}part_a`] });
  });
});

describe('createPhrase records the author as one voter', () => {
  it('votes on both axes, because a phrase always has components', async () => {
    await createWord(pool, { wordId: `${NS}oju`, displayText: 'ojú', syllables: ['o', 'jú'], citation: EXEMPT }, curator);
    await createWord(pool, { wordId: `${NS}sanma`, displayText: 'sánmà', syllables: ['sán', 'mà'], citation: EXEMPT }, curator);

    const wordId = `${NS}oju_sanma_sky`;
    await createPhrase(
      pool,
      {
        wordId,
        displayText: 'ojú sánmà',
        syllables: ['o', 'jú', 'sán', 'mà'],
        components: [`${NS}oju`, `${NS}sanma`],
        definition: 'the sky',
      },
      curator,
    );

    const rows = await pool.query<{ axis: string }>(
      "select axis from contributions where word_id = $1 and status = 'active' order by axis",
      [wordId],
    );
    expect(rows.rows.map((r) => r.axis)).toEqual(['entry', 'etymology']);
  });
});

describe('what the author\'s vote changes about consensus', () => {
  it('counts toward the agreement threshold like any other vote', async () => {
    const wordId = `${NS}agreed`;
    await createWord(pool, { wordId, displayText: 'agr', syllables: ['agr'], citation: EXEMPT }, curator);
    // One author + one agreeing volunteer reaches the threshold. Before, the author counted for
    // nothing and this word sat at 'single' with one vote.
    expect(AGREEMENT_THRESHOLD).toBe(2);
    expect(await bucketOf(wordId, 'entry')).toBe('single');

    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { action: 'keep_ours', definitionAction: 'confirm' } },
      ada,
    );
    expect(await bucketOf(wordId, 'entry')).toBe('ready');
  });

  it('makes a disagreeing volunteer CONTEST the word instead of quietly outvoting it', async () => {
    const wordId = `${NS}contested`;
    await createWord(pool, { wordId, displayText: 'con', syllables: ['con'], citation: EXEMPT }, curator);

    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { action: 'respell', newDisplayText: 'cón', newSyllables: ['cón'] } },
      ada,
    );

    // Two distinct claims, so it needs a human and jumps the queue. This is the case that used to
    // be invisible: with the author holding no vote, one volunteer looked like the only opinion.
    expect(await bucketOf(wordId, 'entry')).toBe('contested');
  });

  it('keeps two agreeing volunteers from bulk-confirming over the author unnoticed', async () => {
    const wordId = `${NS}outvoted`;
    await createWord(pool, { wordId, displayText: 'out', syllables: ['out'], citation: EXEMPT }, curator);

    for (const voter of [ada, ben]) {
      // eslint-disable-next-line no-await-in-loop
      await submitContribution(
        pool,
        { axis: 'entry', wordId, proposedValue: { action: 'respell', newDisplayText: 'óut', newSyllables: ['óut'] } },
        voter,
      );
    }

    // The volunteers outnumber the author 2-1, but the word is CONTESTED rather than 'ready', so it
    // never reaches the bulk-confirm queue - a curator has to look at it. That is the whole point:
    // this used to be a clean 'ready' with the author's spelling nowhere in the tally.
    expect(await bucketOf(wordId, 'entry')).toBe('contested');
  });
});

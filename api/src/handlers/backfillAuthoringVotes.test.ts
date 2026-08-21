// The one-off backfill, and - mostly - proof of what it does NOT touch.
//
// This runs once against real data that arrived by direct database writes, including audio
// attached to placeholder speakers whose accounts were never linked. So the assertions that matter
// least are the ones about contributions appearing, and the ones that matter most are the ones
// showing every other table byte-identical afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { planAuthoringVoteBackfill, applyAuthoringVoteBackfill } from './backfillAuthoringVotes.js';
import { createWord } from './createWord.js';
import { submitContribution } from './submitContribution.js';
import { applyEtymologyDecision } from './applyEtymologyDecision.js';
import { writeCitationInTransaction } from './upstreamCitations.js';

const NS = 'testbav_';
const EXEMPT = { exemptReason: 'seeded word, no upstream entry' } as const;
const pool = getTestPool();
let owner: string;
let ada: string;

/** A word written the way the seeded corpus was: straight into golden_record, no contribution,
 * no decision, and - for this one - a recording by a placeholder speaker. */
async function seedWordWithAudio(wordId: string, displayText: string) {
  await pool.query(
    'insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)',
    [wordId, displayText, [displayText], 'a seeded meaning'],
  );
  // Through the real writer: the pin column is not-null and this is the only thing that fills it.
  await writeCitationInTransaction(pool, wordId, { exemptReason: 'seeded' }, owner);
  const speaker = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name) values ($1) returning speaker_id',
    [`${NS}speaker1`],
  );
  const utterance = await pool.query<{ utterance_id: string }>(
    // recorded_display_text is 0006's frozen spelling-at-recording-time - not-null, and exactly the
    // kind of seeded audio metadata this test exists to show the backfill does not disturb.
    `insert into utterances (word_id, speaker_id, blob_path, recorded_display_text, recorded_syllables)
     values ($1, $2, $3, $4, $5) returning utterance_id`,
    [wordId, speaker.rows[0].speaker_id, `utterances/${wordId}.wav`, displayText, [displayText]],
  );
  return { speakerId: speaker.rows[0].speaker_id, utteranceId: utterance.rows[0].utterance_id };
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
  owner = await mk('owner@example.com', 'curator');
  ada = await mk('ada@example.com', 'volunteer');
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('the backfill leaves everything except contributions alone', () => {
  it('does not touch a seeded word\'s content, citation, speaker or recording', async () => {
    const wordId = `${NS}seeded_epo`;
    const { speakerId, utteranceId } = await seedWordWithAudio(wordId, 'epo');

    const before = await pool.query(
      `select g.display_text, g.syllables, g.definition, g.updated_by, c.exempt_reason,
              u.utterance_id, u.speaker_id, u.blob_path, s.display_name as speaker_name
         from golden_record g
         join upstream_citations c on c.word_id = g.word_id
         join utterances u on u.word_id = g.word_id
         join speakers s on s.speaker_id = u.speaker_id
        where g.word_id = $1`,
      [wordId],
    );

    const plan = await planAuthoringVoteBackfill(pool, owner);
    await applyAuthoringVoteBackfill(pool, owner, plan);

    const after = await pool.query(
      `select g.display_text, g.syllables, g.definition, g.updated_by, c.exempt_reason,
              u.utterance_id, u.speaker_id, u.blob_path, s.display_name as speaker_name
         from golden_record g
         join upstream_citations c on c.word_id = g.word_id
         join utterances u on u.word_id = g.word_id
         join speakers s on s.speaker_id = u.speaker_id
        where g.word_id = $1`,
      [wordId],
    );

    // Byte-identical: the spelling, the meaning, the exemption, the placeholder speaker and the
    // recording attached to them all survive untouched.
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].utterance_id).toBe(utteranceId);
    expect(after.rows[0].speaker_id).toBe(speakerId);
    // And updated_by is still null - the backfill does not claim to have edited the word.
    expect(after.rows[0].updated_by).toBeNull();
  });

  it('writes no word_decisions rows, so nothing becomes silently settled', async () => {
    const wordId = `${NS}still_open`;
    await seedWordWithAudio(wordId, 'ilé');

    const plan = await planAuthoringVoteBackfill(pool, owner);
    await applyAuthoringVoteBackfill(pool, owner, plan);

    const decisions = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
    expect(decisions.rowCount).toBe(0);
  });
});

describe('what the backfill writes, and refuses to write', () => {
  it('casts an entry vote for a seeded word that had none', async () => {
    const wordId = `${NS}needs_vote`;
    await seedWordWithAudio(wordId, 'ọwọ́');

    const plan = await planAuthoringVoteBackfill(pool, owner);
    expect(plan.planned).toContainEqual({ wordId, axis: 'entry' });
    await applyAuthoringVoteBackfill(pool, owner, plan);

    const rows = await pool.query<{ resolved_value: Record<string, unknown>; note: string }>(
      "select resolved_value, note from contributions where word_id = $1 and axis = 'entry' and status = 'active'",
      [wordId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].resolved_value).toMatchObject({ kind: 'entry', displayText: 'ọwọ́' });
    // The row says what it is, rather than posing as somebody at a form.
    expect(rows.rows[0].note).toMatch(/Backfilled/);
  });

  it('NEVER supersedes a real vote the user already cast', async () => {
    const wordId = `${NS}already_mine`;
    await seedWordWithAudio(wordId, 'ẹsẹ̀');
    const mine = await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { action: 'respell', newDisplayText: 'ẹsẹ', newSyllables: ['ẹsẹ'] } },
      owner,
    );

    const plan = await planAuthoringVoteBackfill(pool, owner);
    expect(plan.skipped).toContainEqual({ wordId, axis: 'entry', reason: 'already_voted' });
    await applyAuthoringVoteBackfill(pool, owner, plan);

    // Still active, still theirs, still the spelling they actually argued for. Replacing a real
    // opinion with a synthesized keep_ours would overwrite evidence with a guess about it.
    const row = await pool.query<{ contribution_id: string; status: string }>(
      "select contribution_id, status from contributions where word_id = $1 and axis = 'entry'",
      [wordId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].contribution_id).toBe(mine.contributionId);
    expect(row.rows[0].status).toBe('active');
  });

  it('leaves another user\'s vote alone and contests the word instead', async () => {
    const wordId = `${NS}ada_voted`;
    await seedWordWithAudio(wordId, 'ojú');
    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { action: 'respell', newDisplayText: 'oju', newSyllables: ['oju'] } },
      ada,
    );

    const plan = await planAuthoringVoteBackfill(pool, owner);
    await applyAuthoringVoteBackfill(pool, owner, plan);

    const rows = await pool.query<{ submitted_by: string; status: string }>(
      "select submitted_by, status from contributions where word_id = $1 and axis = 'entry' order by submitted_at",
      [wordId],
    );
    // Two active votes, disagreeing - which is the entire purpose of the exercise.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.status === 'active')).toBe(true);
    expect(rows.rows.map((r) => r.submitted_by).sort()).toEqual([ada, owner].sort());
  });

  it('casts no etymology vote for a word with no components on record', async () => {
    const wordId = `${NS}atomic_seed`;
    await seedWordWithAudio(wordId, 'omi');

    const plan = await planAuthoringVoteBackfill(pool, owner);
    expect(plan.skipped).toContainEqual({ wordId, axis: 'etymology', reason: 'no_components' });
    await applyAuthoringVoteBackfill(pool, owner, plan);

    const rows = await pool.query("select 1 from contributions where word_id = $1 and axis = 'etymology'", [wordId]);
    expect(rows.rowCount).toBe(0);
  });

  it('skips an axis that already carries a decision', async () => {
    const partId = `${NS}decided_part`;
    const wordId = `${NS}decided_word`;
    await createWord(pool, { wordId: partId, displayText: 'a', syllables: ['a'], citation: EXEMPT }, owner);
    await seedWordWithAudio(wordId, 'ab');
    await pool.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)',
      [wordId, partId],
    );
    await applyEtymologyDecision(pool, wordId, { componentsAction: 'confirm_existing' }, owner);

    const plan = await planAuthoringVoteBackfill(pool, owner);
    expect(plan.skipped).toContainEqual({ wordId, axis: 'etymology', reason: 'already_decided' });
  });

  it('stops at the limit and says how many are left', async () => {
    // The applier is called from an HTTP request, where the whole set outlives the gateway
    // timeout. Bounded and resumable beats fast and all-or-nothing.
    for (const n of ['lim_a', 'lim_b', 'lim_c']) await seedWordWithAudio(`${NS}${n}`, n);

    const plan = await planAuthoringVoteBackfill(pool, owner);
    const planned = plan.planned.length;
    expect(planned).toBeGreaterThan(2);

    const first = await applyAuthoringVoteBackfill(pool, owner, plan, 2);
    expect(first.written).toBe(2);
    expect(first.remaining).toBe(planned - 2);

    // Every vote committed on its own, so re-planning simply finds less to do - the work already
    // done is not repeated and not lost.
    const second = await planAuthoringVoteBackfill(pool, owner);
    expect(second.planned.length).toBe(planned - 2);
  });

  it('reports remaining 0 when it gets through everything', async () => {
    await seedWordWithAudio(`${NS}unbounded`, 'gbogbo');
    const plan = await planAuthoringVoteBackfill(pool, owner);
    const result = await applyAuthoringVoteBackfill(pool, owner, plan);
    expect(result.remaining).toBe(0);
    expect(result.written).toBe(plan.planned.length);
  });

  it('is safe to run twice: the second pass has nothing left to do', async () => {
    const wordId = `${NS}idempotent`;
    await seedWordWithAudio(wordId, 'igi');

    await applyAuthoringVoteBackfill(pool, owner, await planAuthoringVoteBackfill(pool, owner));
    const second = await planAuthoringVoteBackfill(pool, owner);
    expect(second.planned.filter((p) => p.wordId === wordId)).toEqual([]);

    const result = await applyAuthoringVoteBackfill(pool, owner, second);
    expect(result.failed).toEqual([]);
    const rows = await pool.query("select 1 from contributions where word_id = $1 and status = 'active'", [wordId]);
    expect(rows.rowCount).toBe(1);
  });
});

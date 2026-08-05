import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listContributions } from './listContributions.js';
import { submitContribution } from './submitContribution.js';

const NS = 'testlistcontrib_';
const pool = getTestPool();
let volunteerUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const volunteer = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}volunteer`, 'Test Volunteer', 'volunteer'],
  );
  volunteerUserId = volunteer.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('listContributions', () => {
  it('lists a real pending contribution with word/submitter context', async () => {
    const wordId = `${NS}pending_word`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId, `${NS}pendingspelling`, [`${NS}pendingspelling`],
    ]);
    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { action: 'keep_ours', definitionAction: 'custom', definitionText: 'proposed text' }, note: 'a note' },
      volunteerUserId,
    );

    const contributions = await listContributions(pool, 'active');
    const found = contributions.find((c) => c.wordId === wordId);

    expect(found).toBeDefined();
    expect(found?.wordDisplayText).toBe(`${NS}pendingspelling`);
    expect(found?.axis).toBe('entry');
    expect(found?.submittedBy).toBe(`${NS}volunteer`);
    expect(found?.note).toBe('a note');
    expect(found?.status).toBe('active');
  });

  it('drops an excluded contribution from the default filter but keeps it findable', async () => {
    // Exclusion sets a row aside from the tally without deleting the belief, so
    // it must still be retrievable under its own status.
    const result = await submitContribution(
      pool,
      { axis: 'new_entry', proposedValue: { proposedWordId: `${NS}newentryword`, displayText: 'x', syllables: ['x'], type: 'word' } },
      volunteerUserId,
    );
    await pool.query("update contributions set status = 'excluded' where contribution_id = $1", [result.contributionId]);

    const active = await listContributions(pool, 'active');
    expect(active.find((c) => c.contributionId === result.contributionId)).toBeUndefined();

    const excluded = await listContributions(pool, 'excluded');
    expect(excluded.find((c) => c.contributionId === result.contributionId)).toBeDefined();
  });
});

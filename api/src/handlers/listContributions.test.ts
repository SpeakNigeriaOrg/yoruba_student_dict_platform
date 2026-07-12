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
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
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
      { axis: 'definition', wordId, proposedValue: { definitionAction: 'custom', definitionText: 'proposed text' }, note: 'a note' },
      volunteerUserId,
    );

    const contributions = await listContributions(pool, 'pending');
    const found = contributions.find((c) => c.wordId === wordId);

    expect(found).toBeDefined();
    expect(found?.wordDisplayText).toBe(`${NS}pendingspelling`);
    expect(found?.axis).toBe('definition');
    expect(found?.submittedBy).toBe(`${NS}volunteer`);
    expect(found?.note).toBe('a note');
    expect(found?.status).toBe('pending');
  });

  it('does not list a new_entry contribution under the default pending filter after it is rejected', async () => {
    const result = await submitContribution(
      pool,
      { axis: 'new_entry', proposedValue: { proposedWordId: `${NS}newentryword`, displayText: 'x', syllables: ['x'], type: 'word' } },
      volunteerUserId,
    );
    await pool.query("update contributions set status = 'rejected' where contribution_id = $1", [result.contributionId]);

    const pending = await listContributions(pool, 'pending');
    expect(pending.find((c) => c.contributionId === result.contributionId)).toBeUndefined();

    const rejected = await listContributions(pool, 'rejected');
    expect(rejected.find((c) => c.contributionId === result.contributionId)).toBeDefined();
  });
});

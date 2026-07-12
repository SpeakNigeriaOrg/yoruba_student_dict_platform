import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { ContributionAlreadyReviewedError, ContributionNotFoundError } from './approveContribution.js';
import { rejectContribution } from './rejectContribution.js';
import { submitContribution } from './submitContribution.js';

const NS = 'testrejcontrib_';
const pool = getTestPool();
let volunteerUserId: string;
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const volunteer = await pool.query<{ user_id: string }>(
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}volunteer`, 'Test Volunteer', 'volunteer'],
  );
  volunteerUserId = volunteer.rows[0].user_id;
  const curator = await pool.query<{ user_id: string }>(
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator`, 'Test Curator', 'curator'],
  );
  curatorUserId = curator.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('rejectContribution', () => {
  it('rejects a real pending contribution without applying its proposed_value', async () => {
    const wordId = `${NS}reject_word`;
    await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
      wordId, `${NS}rejectspelling`, [`${NS}rejectspelling`], 'original definition',
    ]);
    const submitted = await submitContribution(
      pool,
      { axis: 'definition', wordId, proposedValue: { definitionAction: 'custom', definitionText: 'should never be applied' } },
      volunteerUserId,
    );

    await rejectContribution(pool, submitted.contributionId, curatorUserId);

    const contribution = await pool.query<{ status: string; reviewed_by: string }>(
      'select status, reviewed_by from contributions where contribution_id = $1',
      [submitted.contributionId],
    );
    expect(contribution.rows[0].status).toBe('rejected');
    expect(contribution.rows[0].reviewed_by).toBe(curatorUserId);

    const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].definition).toBe('original definition');
  });

  it('rejects a contribution_id that does not exist', async () => {
    await expect(
      rejectContribution(pool, '00000000-0000-0000-0000-000000000000', curatorUserId),
    ).rejects.toThrow(ContributionNotFoundError);
  });

  it('refuses to reject an already-reviewed contribution', async () => {
    const wordId = `${NS}already_reviewed_word`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId, `${NS}alreadyspelling`, [`${NS}alreadyspelling`],
    ]);
    const submitted = await submitContribution(
      pool,
      { axis: 'definition', wordId, proposedValue: { definitionAction: 'confirm' } },
      volunteerUserId,
    );
    await rejectContribution(pool, submitted.contributionId, curatorUserId);

    await expect(rejectContribution(pool, submitted.contributionId, curatorUserId)).rejects.toThrow(
      ContributionAlreadyReviewedError,
    );
  });
});

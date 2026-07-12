import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { submitContribution } from './submitContribution.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testsub_';
const pool = getTestPool();
let volunteerUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (username, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}volunteer@example.com`, 'Test Volunteer', 'volunteer'],
  );
  volunteerUserId = result.rows[0].user_id;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    `${NS}existing_word`,
    'x',
    ['x'],
    'old definition',
  ]);
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('submitContribution', () => {
  it('records a pending spelling contribution against an existing word', async () => {
    const { contributionId } = await submitContribution(
      pool,
      { axis: 'spelling', wordId: `${NS}existing_word`, proposedValue: { action: 'keep_ours' } },
      volunteerUserId,
    );

    const row = await pool.query('select word_id, axis, status, submitted_by from contributions where contribution_id = $1', [
      contributionId,
    ]);
    expect(row.rows[0]).toEqual({
      word_id: `${NS}existing_word`,
      axis: 'spelling',
      status: 'pending',
      submitted_by: volunteerUserId,
    });
  });

  it('records a new_entry contribution with a null word_id', async () => {
    const { contributionId } = await submitContribution(
      pool,
      {
        axis: 'new_entry',
        proposedValue: { proposedWordId: `${NS}epo_oil`, displayText: 'epo', syllables: ['e', 'po'], type: 'word' },
      },
      volunteerUserId,
    );

    const row = await pool.query<{ word_id: string | null }>('select word_id from contributions where contribution_id = $1', [
      contributionId,
    ]);
    expect(row.rows[0].word_id).toBeNull();
  });

  it('rejects a spelling/definition/etymology contribution against a nonexistent word_id', async () => {
    await expect(
      submitContribution(
        pool,
        { axis: 'definition', wordId: `${NS}nonexistent`, proposedValue: { definitionAction: 'confirm' } },
        volunteerUserId,
      ),
    ).rejects.toThrow(WordNotFoundError);
  });

  it('stores the note alongside the proposed_value', async () => {
    const { contributionId } = await submitContribution(
      pool,
      {
        axis: 'definition',
        wordId: `${NS}existing_word`,
        proposedValue: { definitionAction: 'custom', definitionText: 'new meaning' },
        note: 'found a better gloss',
      },
      volunteerUserId,
    );

    const row = await pool.query<{ note: string; proposed_value: unknown }>(
      'select note, proposed_value from contributions where contribution_id = $1',
      [contributionId],
    );
    expect(row.rows[0].note).toBe('found a better gloss');
    expect(row.rows[0].proposed_value).toEqual({ definitionAction: 'custom', definitionText: 'new meaning' });
  });
});

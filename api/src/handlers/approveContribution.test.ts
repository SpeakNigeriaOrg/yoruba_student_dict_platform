import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import {
  approveContribution,
  ContributionAlreadyReviewedError,
  ContributionNotFoundError,
} from './approveContribution.js';
import { submitContribution } from './submitContribution.js';
import { WordIdAlreadyExistsError } from './errors.js';

const NS = 'testapp_';
const pool = getTestPool();
let volunteerUserId: string;
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const volunteer = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}volunteer@example.com`, 'Test Volunteer', 'volunteer'],
  );
  volunteerUserId = volunteer.rows[0].user_id;
  const curator = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = curator.rows[0].user_id;
  await pool.query(
    "insert into golden_record (word_id, display_text, syllables) values ($1, 'a', array['a']), ($2, 'b', array['b'])",
    [`${NS}comp_a`, `${NS}comp_b`],
  );
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string, definition: string | null = null): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'x',
    ['x'],
    definition,
  ]);
}

describe('approveContribution', () => {
  it('approves a spelling contribution: applies the decision and records word_decisions', async () => {
    const wordId = `${NS}spelling_word`;
    await insertWord(wordId);
    const { contributionId } = await submitContribution(
      pool,
      { axis: 'spelling', wordId, proposedValue: { action: 'keep_ours' } },
      volunteerUserId,
    );

    await approveContribution(pool, contributionId, curatorUserId);

    const decision = await pool.query("select decided_by from word_decisions where word_id = $1 and axis = 'spelling'", [
      wordId,
    ]);
    expect(decision.rows[0].decided_by).toBe(curatorUserId);

    const status = await pool.query<{ status: string; reviewed_by: string }>(
      'select status, reviewed_by from contributions where contribution_id = $1',
      [contributionId],
    );
    expect(status.rows[0]).toEqual({ status: 'approved', reviewed_by: curatorUserId });
  });

  it('approves a definition contribution: overwrites the definition text', async () => {
    const wordId = `${NS}definition_word`;
    await insertWord(wordId, 'old text');
    const { contributionId } = await submitContribution(
      pool,
      { axis: 'definition', wordId, proposedValue: { definitionAction: 'custom', definitionText: 'volunteer text' } },
      volunteerUserId,
    );

    await approveContribution(pool, contributionId, curatorUserId);

    const word = await pool.query<{ definition: string }>('select definition from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].definition).toBe('volunteer text');
  });

  it('approves an etymology contribution: writes the proposed components in order', async () => {
    const wordId = `${NS}etymology_word`;
    await insertWord(wordId);
    const { contributionId } = await submitContribution(
      pool,
      {
        axis: 'etymology',
        wordId,
        proposedValue: { componentsAction: 'accept_proposed', components: [`${NS}comp_a`, `${NS}comp_b`] },
      },
      volunteerUserId,
    );

    await approveContribution(pool, contributionId, curatorUserId);

    const rows = await pool.query<{ component_word_id: string }>(
      'select component_word_id from golden_record_components where word_id = $1 order by component_position',
      [wordId],
    );
    expect(rows.rows.map((r) => r.component_word_id)).toEqual([`${NS}comp_a`, `${NS}comp_b`]);
  });

  it('approves a new_entry word contribution: creates the golden_record row', async () => {
    const wordId = `${NS}new_word`;
    const { contributionId } = await submitContribution(
      pool,
      { axis: 'new_entry', proposedValue: { proposedWordId: wordId, displayText: 'epo', syllables: ['e', 'po'], type: 'word' } },
      volunteerUserId,
    );

    await approveContribution(pool, contributionId, curatorUserId);

    const word = await pool.query<{ entry_type: string | null; updated_by: string }>(
      'select entry_type, updated_by from golden_record where word_id = $1',
      [wordId],
    );
    expect(word.rows[0]).toEqual({ entry_type: null, updated_by: curatorUserId });
  });

  it('approves a new_entry phrase contribution: creates the golden_record row and its components', async () => {
    const wordId = `${NS}new_phrase`;
    const { contributionId } = await submitContribution(
      pool,
      {
        axis: 'new_entry',
        proposedValue: {
          proposedWordId: wordId,
          displayText: 'a b',
          syllables: ['a', 'b'],
          type: 'phrase',
          components: [`${NS}comp_a`, `${NS}comp_b`],
        },
      },
      volunteerUserId,
    );

    await approveContribution(pool, contributionId, curatorUserId);

    const word = await pool.query<{ entry_type: string }>('select entry_type from golden_record where word_id = $1', [wordId]);
    expect(word.rows[0].entry_type).toBe('phrase');
    const rows = await pool.query('select component_word_id from golden_record_components where word_id = $1', [wordId]);
    expect(rows.rowCount).toBe(2);
  });

  it('rejects a new_entry phrase contribution referencing a nonexistent component, leaving the contribution pending and creating nothing', async () => {
    const wordId = `${NS}bad_new_phrase`;
    const { contributionId } = await submitContribution(
      pool,
      {
        axis: 'new_entry',
        proposedValue: {
          proposedWordId: wordId,
          displayText: 'a b',
          syllables: ['a', 'b'],
          type: 'phrase',
          components: [`${NS}comp_a`, `${NS}nonexistent`],
        },
      },
      volunteerUserId,
    );

    await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow();

    const word = await pool.query('select 1 from golden_record where word_id = $1', [wordId]);
    expect(word.rowCount).toBe(0);

    const status = await pool.query<{ status: string }>('select status from contributions where contribution_id = $1', [
      contributionId,
    ]);
    expect(status.rows[0].status).toBe('pending');
  });

  it('rejects approving a new_entry word whose proposedWordId already exists', async () => {
    const wordId = `${NS}already_exists_word`;
    await insertWord(wordId);
    const { contributionId } = await submitContribution(
      pool,
      { axis: 'new_entry', proposedValue: { proposedWordId: wordId, displayText: 'y', syllables: ['y'], type: 'word' } },
      volunteerUserId,
    );

    await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow(WordIdAlreadyExistsError);
  });

  it('rejects re-approving an already-approved contribution', async () => {
    const wordId = `${NS}reapprove_word`;
    await insertWord(wordId);
    const { contributionId } = await submitContribution(
      pool,
      { axis: 'spelling', wordId, proposedValue: { action: 'keep_ours' } },
      volunteerUserId,
    );

    await approveContribution(pool, contributionId, curatorUserId);
    await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow(ContributionAlreadyReviewedError);
  });

  it('rejects approving a contribution id that does not exist', async () => {
    await expect(
      approveContribution(pool, '00000000-0000-0000-0000-000000000000', curatorUserId),
    ).rejects.toThrow(ContributionNotFoundError);
  });
});
